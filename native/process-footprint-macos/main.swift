import Darwin

// Prints "<pid> <phys_footprint bytes>" for every process this user may inspect.
// With `--pane-identity <pid>...` it prints "<pid>\t<ORCA_WORKTREE_ID>\t<ORCA_PANE_KEY>" for each
// of those processes whose environment names a workspace.
func footprint(_ pid: pid_t) -> UInt64? {
  var info = rusage_info_v0()
  let rc = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
      proc_pid_rusage(pid, RUSAGE_INFO_V0, $0)
    }
  }
  return rc == 0 ? info.ri_phys_footprint : nil
}

let worktreeVariable = Array("ORCA_WORKTREE_ID=".utf8)
let paneVariable = Array("ORCA_PANE_KEY=".utf8)

func value(of variable: [UInt8], in buffer: [UInt8], from start: Int, to end: Int) -> String? {
  guard end - start >= variable.count,
    buffer[start..<(start + variable.count)].elementsEqual(variable)
  else { return nil }
  let text = String(decoding: buffer[(start + variable.count)..<end], as: UTF8.self)
  // The output is tab- and line-separated.
  return text.contains("\t") || text.contains("\n") ? nil : text
}

// KERN_PROCARGS2 is argc, the executable path, padding, argv, then the environment.
func paneIdentity(_ pid: pid_t, _ buffer: inout [UInt8]) -> (worktree: String, pane: String)? {
  var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
  var length = buffer.count
  guard sysctl(&mib, 3, &buffer, &length, nil, 0) == 0, length > MemoryLayout<Int32>.size
  else { return nil }
  let argc = buffer.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
  var index = MemoryLayout<Int32>.size
  while index < length && buffer[index] != 0 { index += 1 }
  while index < length && buffer[index] == 0 { index += 1 }
  var skipped: Int32 = 0
  while index < length && skipped < argc {
    while index < length && buffer[index] != 0 { index += 1 }
    index += 1
    skipped += 1
  }
  var worktree: String?
  var pane = ""
  while index < length && buffer[index] != 0 {
    let start = index
    while index < length && buffer[index] != 0 { index += 1 }
    if let found = value(of: worktreeVariable, in: buffer, from: start, to: index) {
      worktree = found
    } else if let found = value(of: paneVariable, in: buffer, from: start, to: index) {
      pane = found
    }
    index += 1
  }
  guard let worktree, !worktree.isEmpty else { return nil }
  return (worktree, pane)
}

var output = ""
let arguments = CommandLine.arguments
if arguments.count > 1 && arguments[1] == "--pane-identity" {
  var argumentLimit: Int32 = 0
  var limitSize = MemoryLayout<Int32>.size
  var limitMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
  if sysctl(&limitMib, 2, &argumentLimit, &limitSize, nil, 0) != 0 || argumentLimit <= 0 {
    argumentLimit = 1 << 20
  }
  var buffer = [UInt8](repeating: 0, count: Int(argumentLimit))
  for argument in arguments.dropFirst(2) {
    if let pid = pid_t(argument), pid > 0, let identity = paneIdentity(pid, &buffer) {
      output += "\(pid)\t\(identity.worktree)\t\(identity.pane)\n"
    }
  }
} else {
  let capacity = Int(proc_listallpids(nil, 0)) + 64
  var pids = [pid_t](repeating: 0, count: max(capacity, 64))
  let count = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.stride)))
  for pid in pids.prefix(max(count, 0)) where pid > 0 {
    if let bytes = footprint(pid) {
      output += "\(pid) \(bytes)\n"
    }
  }
}
print(output, terminator: "")
