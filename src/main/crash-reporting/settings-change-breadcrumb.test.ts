import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeCrashReportString } from '../../shared/crash-reporting'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'
import { clearCrashBreadcrumbsForTest, getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import {
  describeSettingValueForCrashReport,
  recordSettingsChangeCrashBreadcrumb,
  SAFE_ENUM_SETTING_VALUES
} from './settings-change-breadcrumb'

const GITHUB_TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
const ABSOLUTE_PATH = '/Users/fieldreporter/work/acme-private-monorepo'
// A hostname carries no secret or path pattern, so only the shape rule keeps it out.
const PRIVATE_HOSTNAME = 'ci-box.acme-internal.example'

function silentSink(): TracerSink {
  return { push: vi.fn(), flush: vi.fn(), close: vi.fn() }
}

beforeEach(() => {
  setActiveSink(silentSink())
  clearCrashBreadcrumbsForTest()
})

afterEach(() => {
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
})

describe('recordSettingsChangeCrashBreadcrumb', () => {
  it('records the changed key and its boolean value', () => {
    recordSettingsChangeCrashBreadcrumb(['keepComputerAwakeWhileAgentsRun'], {
      keepComputerAwakeWhileAgentsRun: false
    })

    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'settings_changed',
        data: expect.objectContaining({
          changedKeyCount: 1,
          keepComputerAwakeWhileAgentsRun: false
        })
      })
    ])
  })

  it('records an allowlisted enum value verbatim so a user note can be checked', () => {
    // The motivating case: report 0d740d3f's note said "turning of the always on mode".
    recordSettingsChangeCrashBreadcrumb(['computerAwakeMode'], { computerAwakeMode: 'off' })

    expect(getCrashBreadcrumbSnapshot()[0]?.data).toMatchObject({ computerAwakeMode: 'off' })
  })

  it('records nothing when no key actually changed', () => {
    recordSettingsChangeCrashBreadcrumb([], { theme: 'dark' })

    expect(getCrashBreadcrumbSnapshot()).toEqual([])
  })

  it('coalesces a burst of writes to the same keys into one ring entry', () => {
    for (let index = 0; index < 40; index += 1) {
      recordSettingsChangeCrashBreadcrumb(['terminalFontSize'], { terminalFontSize: 12 + index })
    }

    const snapshot = getCrashBreadcrumbSnapshot()
    expect(snapshot).toHaveLength(1)
    // The retained crumb reports the newest value plus the suppressed count.
    expect(snapshot[0]?.data).toMatchObject({ terminalFontSize: 51, suppressedSinceLast: 39 })
  })

  it('caps the value entries a bulk write can put in the ring', () => {
    const keys = Array.from({ length: 20 }, (_index, index) => `bulkKey${String(index)}`)
    recordSettingsChangeCrashBreadcrumb(keys, Object.fromEntries(keys.map((key) => [key, true])))

    const data = getCrashBreadcrumbSnapshot()[0]?.data ?? {}
    expect(data.changedKeyCount).toBe(20)
    expect(data.omittedKeyCount).toBe(8)
    expect(Object.keys(data).filter((key) => key.startsWith('bulkKey'))).toHaveLength(12)
  })
})

describe('settings-change breadcrumb privacy', () => {
  it('never puts a token-shaped or path-shaped setting value in the breadcrumb', () => {
    recordSettingsChangeCrashBreadcrumb(
      ['githubToken', 'workspaceDir', 'mobilePairingCustomAddress', 'agentDefaultEnv'],
      {
        githubToken: GITHUB_TOKEN,
        workspaceDir: ABSOLUTE_PATH,
        mobilePairingCustomAddress: PRIVATE_HOSTNAME,
        agentDefaultEnv: { claude: 'ANTHROPIC_API_KEY=sk-live-9f8e7d6c5b4a3210zyxw' }
      }
    )

    const serialized = JSON.stringify(getCrashBreadcrumbSnapshot())
    expect(serialized).not.toContain(GITHUB_TOKEN)
    expect(serialized).not.toContain('ghp_')
    expect(serialized).not.toContain(ABSOLUTE_PATH)
    expect(serialized).not.toContain('fieldreporter')
    expect(serialized).not.toContain('acme-private-monorepo')
    expect(serialized).not.toContain('sk-live')
    expect(serialized).not.toContain(PRIVATE_HOSTNAME)
    expect(serialized).not.toContain('acme-internal')
    expect(getCrashBreadcrumbSnapshot()[0]?.data).toMatchObject({
      githubToken: `string(${String(GITHUB_TOKEN.length)})`,
      workspaceDir: `string(${String(ABSOLUTE_PATH.length)})`,
      mobilePairingCustomAddress: `string(${String(PRIVATE_HOSTNAME.length)})`,
      agentDefaultEnv: 'object(1)'
    })
  })

  it('treats an unrecognised key as unsafe rather than safe', () => {
    expect(describeSettingValueForCrashReport('someFutureSetting', GITHUB_TOKEN)).toBe(
      `string(${String(GITHUB_TOKEN.length)})`
    )
    expect(describeSettingValueForCrashReport('someFutureSetting', [ABSOLUTE_PATH])).toBe(
      'array(1)'
    )
    expect(describeSettingValueForCrashReport('someFutureSetting', '')).toBe('cleared')
    expect(describeSettingValueForCrashReport('someFutureSetting', null)).toBe('unset')
  })

  it('reports a shape for an allowlisted key whose value is off-vocabulary', () => {
    // Widening the allowlist to a key that can hold free text still cannot leak:
    // membership in the key's closed value set is what unlocks a verbatim value.
    for (const key of SAFE_ENUM_SETTING_VALUES.keys()) {
      expect(describeSettingValueForCrashReport(key, GITHUB_TOKEN)).toBe(
        `string(${String(GITHUB_TOKEN.length)})`
      )
      expect(describeSettingValueForCrashReport(key, ABSOLUTE_PATH)).toBe(
        `string(${String(ABSOLUTE_PATH.length)})`
      )
    }
  })

  it('keeps the allowlist keyed, so another key holding the same token stays a shape', () => {
    // The vocabularies are not a global word list. `terminalGpuAcceleration` and
    // `terminalThemeDark` are real settings whose values collide with the tokens
    // allowlisted for `computerAwakeMode` and `theme`; only the owning key unlocks
    // a verbatim value, or a free-text setting could leak whatever it happened to hold.
    expect(describeSettingValueForCrashReport('terminalGpuAcceleration', 'off')).toBe('string(3)')
    expect(describeSettingValueForCrashReport('terminalGpuAcceleration', 'auto')).toBe('string(4)')
    expect(describeSettingValueForCrashReport('terminalThemeDark', 'dark')).toBe('string(4)')
    expect(describeSettingValueForCrashReport('terminalThemeDark', 'system')).toBe('string(6)')
    expect(describeSettingValueForCrashReport('computerAwakeMode', 'off')).toBe('off')
  })

  it('rejects an allowlist entry that is not a short closed-vocabulary token', () => {
    // Fails loudly if someone later allowlists a free-form or path/secret-bearing
    // setting: every listed value must survive the crash redactor unchanged.
    for (const [key, values] of SAFE_ENUM_SETTING_VALUES) {
      expect(values.length, `${key} must enumerate its values`).toBeGreaterThan(0)
      for (const value of values) {
        expect(
          value.length,
          `${key}=${value} is too long to be an enum member`
        ).toBeLessThanOrEqual(32)
        expect(value, `${key}=${value} is not a bare enum token`).toMatch(/^[a-z0-9][a-z0-9._-]*$/i)
        expect(sanitizeCrashReportString(value), `${key}=${value} looks redactable`).toBe(value)
      }
    }
  })
})
