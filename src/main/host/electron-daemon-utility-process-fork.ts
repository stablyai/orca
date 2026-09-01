import { utilityProcess } from 'electron'
import type { UtilityProcessForkFn } from '../daemon/daemon-utility-process-fork'

/**
 * The desktop implementation of the daemon launcher's utility-process port.
 *
 * Why it exists: on Linux and Windows a daemon forked directly from the Electron
 * main process inherits Chromium descriptors (the CDP listener among them) for
 * its whole detached lifetime. Chromium launches utility processes with a clean
 * stdio-only descriptor grant, so the daemon launcher forks through one where a
 * desktop host installs this.
 */
export const electronDaemonUtilityProcessFork: UtilityProcessForkFn = (modulePath, args, options) =>
  utilityProcess.fork(modulePath, args ? [...args] : [], options)
