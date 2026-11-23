import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPluginInitSource } from './hermes-managed-plugin-source'

const run = promisify(execFile)

// The plugin is Python; its payload contract runs wherever a Hermes install does.
// Detection must precede describe(): skipIf() reads this at collection, before beforeAll.
const python = ['python3', 'python'].find((candidate) => {
  try {
    execFileSync(candidate, ['-c', 'print(1)'], { timeout: 15_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})
let pluginDir: string | null = null

beforeAll(async () => {
  if (!python) {
    return
  }
  pluginDir = await mkdtemp(join(tmpdir(), 'orca-hermes-plugin-'))
  await writeFile(join(pluginDir, 'orca_status_plugin.py'), getPluginInitSource())
})

afterAll(async () => {
  if (pluginDir) {
    await rm(pluginDir, { recursive: true, force: true })
  }
})

const scenario = (profileName: string | undefined, kwargs: Record<string, unknown>) => {
  if (!python || !pluginDir) {
    // Unreachable while the suite is enabled: skipped describes never call scenario().
    throw new Error('Python or the generated plugin file is unavailable')
  }
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("plugin", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
class Ctx:
    def __init__(self, profile_name):
        if profile_name is not None:
            self.profile_name = profile_name
        self.hooks = {}
    def register_hook(self, name, fn):
        self.hooks[name] = fn
profile = sys.argv[2] if sys.argv[2] != "-" else None
ctx = Ctx(profile)
mod.register(ctx)
print(json.dumps({
    "named": mod.NAMED_PROFILE,
    "payload": mod._payload_for_event("on_session_start", json.loads(sys.argv[3])),
}))`
  return run(python, [
    '-c',
    script,
    join(pluginDir, 'orca_status_plugin.py'),
    profileName ?? '-',
    JSON.stringify(kwargs)
  ], { timeout: 15_000 }).then(({ stdout }) => {
    const parsed: { named: string; payload: Record<string, unknown> } = JSON.parse(stdout.trim())
    return parsed
  })
}

describe.skipIf(python === undefined)('hermes orca-status plugin', () => {
  const kwargs = { session_id: 'abc-123', model: 'hermes-4', platform: 'tui' }

  it('reports the named profile its register context carries', async () => {
    const { named, payload } = await scenario('work', kwargs)
    expect(named).toBe('work')
    expect(payload.hermes_profile).toBe('work')
    expect(payload.session_id).toBe('abc-123')
  })

  it('leaves default and Hermes-Desktop homes unnamed in every payload', async () => {
    for (const profileName of ['default', 'custom', undefined]) {
      const { named, payload } = await scenario(profileName, kwargs)
      expect(named).toBe(profileName ?? '')
      expect(payload.hermes_profile).toBeUndefined()
      expect(payload.session_id).toBe('abc-123')
    }
  })
})
