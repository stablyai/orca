import Darwin

// Prints "<pid> <phys_footprint bytes>" for every process this user may inspect.
func footprint(_ pid: pid_t) -> UInt64? {
  var info = rusage_info_v0()
  let rc = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
      proc_pid_rusage(pid, RUSAGE_INFO_V0, $0)
    }
  }
  return rc == 0 ? info.ri_phys_footprint : nil
}

let capacity = Int(proc_listallpids(nil, 0)) + 64
var pids = [pid_t](repeating: 0, count: max(capacity, 64))
let count = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.stride)))
var output = ""
for pid in pids.prefix(max(count, 0)) where pid > 0 {
  if let bytes = footprint(pid) {
    output += "\(pid) \(bytes)\n"
  }
}
print(output, terminator: "")
