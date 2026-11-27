import Darwin

// Reads "<client host> <client port> <listener host> <listener port>" lines and answers "own" when one
// of this user's processes holds that TCP connection's client end, else "none". Without root,
// proc_pidfdinfo can't read another account's sockets, so a connection from one is never "own".

setvbuf(stdout, nil, _IOLBF, 0)
let ownUid = getuid()
let fdinfoStride = MemoryLayout<proc_fdinfo>.stride
let socketInfoSize = Int32(MemoryLayout<socket_fdinfo>.stride)
// Browsers keep their connections in one network process, so the last owner is checked first.
var lastOwner: pid_t = 0

func mapped(_ host: Substring) -> [UInt8]? {
  var v6 = in6_addr()
  if inet_pton(AF_INET6, String(host), &v6) == 1 {
    return withUnsafeBytes(of: &v6) { Array($0) }
  }
  var v4 = in_addr()
  if inet_pton(AF_INET, String(host), &v4) == 1 {
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] + withUnsafeBytes(of: &v4) { Array($0) }
  }
  return nil
}

func mapped(_ address: in4in6_addr, _ v6: in6_addr, ipv4: Bool) -> [UInt8] {
  if ipv4 {
    var v4 = address.i46a_addr4
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] + withUnsafeBytes(of: &v4) { Array($0) }
  }
  var copy = v6
  return withUnsafeBytes(of: &copy) { Array($0) }
}

struct Connection {
  let clientHost: [UInt8]
  let clientPort: UInt16
  let listenerHost: [UInt8]
  let listenerPort: UInt16
}

func holds(_ pid: pid_t, _ connection: Connection) -> Bool {
  let size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
  if size <= 0 {
    return false
  }
  var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(size) / fdinfoStride + 16)
  let filled = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &fds, Int32(fds.count * fdinfoStride))
  for fd in fds.prefix(max(Int(filled), 0) / fdinfoStride)
  where fd.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
    var info = socket_fdinfo()
    guard proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &info, socketInfoSize) == socketInfoSize,
      info.psi.soi_kind == Int32(SOCKINFO_TCP)
    else {
      continue
    }
    let inet = info.psi.soi_proto.pri_tcp.tcpsi_ini
    guard UInt16(bigEndian: UInt16(truncatingIfNeeded: inet.insi_lport)) == connection.clientPort,
      UInt16(bigEndian: UInt16(truncatingIfNeeded: inet.insi_fport)) == connection.listenerPort
    else {
      continue
    }
    let ipv4 = inet.insi_vflag & UInt8(INI_IPV4) != 0
    if mapped(inet.insi_laddr.ina_46, inet.insi_laddr.ina_6, ipv4: ipv4) == connection.clientHost
      && mapped(inet.insi_faddr.ina_46, inet.insi_faddr.ina_6, ipv4: ipv4) == connection.listenerHost
    {
      return true
    }
  }
  return false
}

func ownProcesses() -> [pid_t] {
  let bytes = proc_listpids(UInt32(PROC_UID_ONLY), UInt32(ownUid), nil, 0)
  var pids = [pid_t](repeating: 0, count: max(Int(bytes), 0) / MemoryLayout<pid_t>.stride + 64)
  let filled = proc_listpids(
    UInt32(PROC_UID_ONLY), UInt32(ownUid), &pids, Int32(pids.count * MemoryLayout<pid_t>.stride))
  return pids.prefix(max(Int(filled), 0) / MemoryLayout<pid_t>.stride).filter { $0 > 0 }
}

func owner(of connection: Connection) -> pid_t? {
  if lastOwner > 0 && holds(lastOwner, connection) {
    return lastOwner
  }
  for pid in ownProcesses() where pid != lastOwner && holds(pid, connection) {
    lastOwner = pid
    return pid
  }
  return nil
}

while let line = readLine() {
  let fields = line.split(separator: " ")
  guard fields.count == 4,
    let clientHost = mapped(fields[0]), let clientPort = UInt16(fields[1]),
    let listenerHost = mapped(fields[2]), let listenerPort = UInt16(fields[3])
  else {
    print("error malformed request")
    continue
  }
  let connection = Connection(
    clientHost: clientHost, clientPort: clientPort, listenerHost: listenerHost,
    listenerPort: listenerPort)
  print(owner(of: connection) == nil ? "none" : "own")
}
