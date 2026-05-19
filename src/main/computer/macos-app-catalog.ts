import { execFile } from 'child_process'
import type { ComputerAppInfo } from '../../shared/runtime-types'

type MacOSRunningApp = ComputerAppInfo & {
  activationPolicy: number
  isFrontmost: boolean
}

const JXA_LIST_RUNNING_APPS = `
ObjC.import('AppKit');
const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
const out = [];
for (let i = 0; i < apps.count; i += 1) {
  const app = apps.objectAtIndex(i);
  if (app.isTerminated) continue;
  const name = ObjC.unwrap(app.localizedName) || '';
  const bundleId = ObjC.unwrap(app.bundleIdentifier) || null;
  const pid = Number(app.processIdentifier);
  const activationPolicy = Number(app.activationPolicy);
  if (!name || !Number.isInteger(pid) || pid <= 0) continue;
  out.push({
    name,
    bundleId,
    pid,
    activationPolicy,
    isFrontmost: Boolean(app.active)
  });
}
JSON.stringify(out);
`

export async function listMacOSApps(): Promise<ComputerAppInfo[]> {
  const { stdout } = await execFilePromise(
    'osascript',
    ['-l', 'JavaScript', '-e', JXA_LIST_RUNNING_APPS],
    {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024
    }
  )
  const apps = parseMacOSApps(stdout).filter(hasLivePid)
  return dedupeApps(apps.filter(isUserFacingApp)).map(({ name, bundleId, pid }) => ({
    name,
    bundleId,
    pid
  }))
}

function parseMacOSApps(stdout: string): MacOSRunningApp[] {
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed.flatMap((value): MacOSRunningApp[] => {
    if (!value || typeof value !== 'object') {
      return []
    }
    const record = value as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : ''
    const bundleId = typeof record.bundleId === 'string' ? record.bundleId : null
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : 0
    const activationPolicy =
      typeof record.activationPolicy === 'number' && Number.isInteger(record.activationPolicy)
        ? record.activationPolicy
        : -1
    const isFrontmost = record.isFrontmost === true
    return name && pid > 0 ? [{ name, bundleId, pid, activationPolicy, isFrontmost }] : []
  })
}

function isUserFacingApp(app: MacOSRunningApp): boolean {
  return app.activationPolicy === 0
}

function hasLivePid(app: MacOSRunningApp): boolean {
  try {
    process.kill(app.pid, 0)
    return true
  } catch {
    // NSWorkspace can briefly retain terminated apps; filter them before provider calls.
    return false
  }
}

function dedupeApps(apps: MacOSRunningApp[]): MacOSRunningApp[] {
  const seen = new Set<string>()
  const sorted = [...apps].sort((a, b) => {
    if (a.isFrontmost !== b.isFrontmost) {
      return a.isFrontmost ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })
  const result: MacOSRunningApp[] = []
  for (const app of sorted) {
    const key = app.bundleId ? `bundle:${app.bundleId.toLowerCase()}` : `pid:${app.pid}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(app)
  }
  return result
}

function execFilePromise(
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; maxBuffer: number }
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const detail = typeof stderr === 'string' && stderr.trim() ? `: ${stderr.trim()}` : ''
        reject(new Error(`${error.message}${detail}`))
        return
      }
      resolve({ stdout })
    })
  })
}
