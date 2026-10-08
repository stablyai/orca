import path from 'node:path'
import { runProcess } from '../shared/child-process/run-process'

const RUNNING_INSTANCES_SCRIPT = `function run(argv) {
  ObjC.import('AppKit');
  const bundle = $.NSBundle.bundleWithPath(argv[0]);
  const identifier = ObjC.unwrap(bundle.bundleIdentifier);
  if (typeof identifier !== 'string' || !identifier) throw new Error('Missing bundle identifier');
  const target = $.NSURL.fileURLWithPath(argv[0]).URLByStandardizingPath;
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(identifier);
  const pids = [];
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    if (app.bundleURL && app.bundleURL.URLByStandardizingPath.isEqual(target)) {
      pids.push(Number(app.processIdentifier));
    }
  }
  return JSON.stringify(pids);
}`

/** Squirrel waits for every main application process from the target bundle. */
export async function getMacUpdateRunningInstances(
  executable = process.execPath,
  currentPid = process.pid
): Promise<number[]> {
  if (process.platform !== 'darwin' || !executable.includes('.app/Contents/MacOS/')) {
    return []
  }
  const bundlePath = path.dirname(path.dirname(path.dirname(executable)))
  // Match ShipIt's registry query; run-as-node workers share the executable but do not block it.
  const result = await runProcess({
    program: '/usr/bin/osascript',
    args: ['-l', 'JavaScript', '-e', RUNNING_INSTANCES_SCRIPT, bundlePath],
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024,
    killOnOutputLimit: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('Could not check running Orca instances')
  }
  return parseMacUpdateRunningInstances(result.stdout, currentPid)
}

export function parseMacUpdateRunningInstances(listing: string, currentPid: number): number[] {
  const pids: unknown = JSON.parse(listing)
  if (
    !Array.isArray(pids) ||
    !pids.every((pid: unknown) => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0)
  ) {
    throw new Error('Invalid macOS application listing')
  }
  return pids.filter((pid: number) => pid !== currentPid)
}
