import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  loadWindowsNativeRegistry,
  WINDOWS_REG_EXPAND_SZ,
  WINDOWS_REG_SZ
} from './windows-native-registry'

// Why this file exists: the addon behind `@orca/windows-registry` is vendored source rather
// than a published package, so nothing upstream proves it still decodes the registry the way
// Orca's PATH readers expect. These cases check it against `reg.exe`, which is the only
// independent oracle available on the box.
const describeWindows = process.platform === 'win32' ? describe : describe.skip

/** `reg query` prints `    <name>    <TYPE>    <data>` on one line; take the type and data. */
function regQuery(key: string, name: string): { type: string; data: string } | null {
  let stdout: string
  try {
    stdout = execFileSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8' })
  } catch {
    return null
  }
  // reg.exe echoes the name as stored, so a machine holding PATH rather than Path would
  // otherwise miss the line and make the oracle look absent.
  const wanted = name.toLowerCase()
  const line = stdout
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().toLowerCase().startsWith(wanted))
  if (!line) {
    return null
  }
  const match = line.trim().match(/^(\S+)\s+(REG_\w+)\s+([\s\S]*)$/)
  return match ? { type: match[2], data: match[3] } : null
}

describeWindows('vendored windows registry addon', () => {
  it('decodes the user PATH exactly as reg.exe reports it', () => {
    const registry = loadWindowsNativeRegistry()
    const values = registry.getRegistryKey(registry.HK.CU, 'Environment')
    expect(values).toBeTruthy()

    const oracle = regQuery('HKCU\\Environment', 'Path')
    if (!oracle) {
      // A user account may genuinely have no user-scoped PATH; then the addon must agree.
      expect(Object.keys(values ?? {}).some((name) => name.toLowerCase() === 'path')).toBe(false)
      return
    }

    const entry = Object.entries(values ?? {}).find(([name]) => name.toLowerCase() === 'path')?.[1]
    expect(entry).toBeTruthy()
    expect(entry?.value).toBe(oracle.data)
    expect(entry?.type).toBe(
      oracle.type === 'REG_EXPAND_SZ' ? WINDOWS_REG_EXPAND_SZ : WINDOWS_REG_SZ
    )
  })

  it('reads the machine environment key through HKLM', () => {
    const registry = loadWindowsNativeRegistry()
    const values = registry.getRegistryKey(
      registry.HK.LM,
      'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    )
    const entry = Object.entries(values ?? {}).find(([name]) => name.toLowerCase() === 'path')?.[1]
    expect(typeof entry?.value).toBe('string')
    expect(String(entry?.value).length).toBeGreaterThan(0)
  })

  it('returns null for a key that does not exist instead of throwing', () => {
    const registry = loadWindowsNativeRegistry()
    expect(registry.getRegistryKey(registry.HK.CU, 'Software\\OrcaNoSuchKey\\Absent')).toBeNull()
  })

  it('reports every value in the key keyed by its own name', () => {
    const registry = loadWindowsNativeRegistry()
    const values = registry.getRegistryKey(registry.HK.CU, 'Environment') ?? {}
    for (const [name, entry] of Object.entries(values)) {
      expect(entry?.name).toBe(name)
      expect(typeof entry?.type).toBe('number')
    }
  })
})
