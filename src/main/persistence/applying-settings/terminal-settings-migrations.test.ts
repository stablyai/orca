import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { migrateAgentLaunchProfile } from './terminal-settings-migrations'
import {
  composeTuiAgentLaunchArgsRecord,
  composeTuiAgentLaunchEnvRecord,
  resolveComposedTuiAgentLaunchArgs,
  resolveTuiAgentLaunchArgs
} from '../../../shared/tui-agent-launch-defaults'
import {
  PERMISSION_AGENT_IDS,
  resolveAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS
} from '../../../shared/tui-agent-permissions'
import type { TuiAgent } from '../../../shared/tui-agent'

const DARWIN = { platform: 'darwin' } as const

const CLAUDE_BYPASS = '--dangerously-skip-permissions'
const CODEX_BYPASS = '--dangerously-bypass-approvals-and-sandbox'
const YOLO_ENV = { goose: { GOOSE_MODE: 'auto' } }

function legacy(settings: Partial<GlobalSettings>): GlobalSettings {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
  return settings as GlobalSettings
}

/** Every agent in Yolo, the way a profile migrated by an older build stores it. */
function allYoloArgs(): Partial<Record<TuiAgent, string>> {
  return { ...YOLO_TUI_AGENT_ARGS }
}

describe('migrateAgentLaunchProfile', () => {
  it('lifts an all-Yolo profile into a Yolo default with no leftover text', () => {
    const { profile, migrated } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: allYoloArgs(),
        agentDefaultEnv: YOLO_ENV
      })
    )

    expect(migrated).toBe(true)
    expect(profile.agentPermissionMode).toBe('bypass')
    expect(profile.agentPermissionModeOverrides).toEqual({})
    expect(profile.agentDefaultArgs?.claude).toBe('')
    expect(profile.agentDefaultEnv?.goose).toEqual({})
  })

  it('lifts an all-Manual profile into a Manual default', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({ agentYoloDefaultsMigrated: true, agentDefaultArgs: {}, agentDefaultEnv: {} })
    )

    expect(profile.agentPermissionMode).toBe('ask')
    expect(profile.agentPermissionModeOverrides).toEqual({})
  })

  // The #23853 report: Settings read Yolo, yet Claude's custom Arguments held no flag, so Claude
  // launched prompting. The migration must keep what actually launched and say so per agent.
  it('keeps custom arguments without the flag as Manual for that agent only', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { ...allYoloArgs(), claude: '--model opus' },
        agentDefaultEnv: YOLO_ENV
      })
    )

    expect(profile.agentPermissionMode).toBe('bypass')
    expect(profile.agentPermissionModeOverrides).toEqual({ claude: 'ask' })
    expect(profile.agentDefaultArgs?.claude).toBe('--model opus')
  })

  it('lifts the flag out of custom arguments that also carry it', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: {
          ...allYoloArgs(),
          claude: `--model opus ${CLAUDE_BYPASS} --append-system-prompt "keep ${CLAUDE_BYPASS} here"`
        },
        agentDefaultEnv: YOLO_ENV
      })
    )

    expect(profile.agentPermissionModeOverrides).toEqual({})
    expect(profile.agentDefaultArgs?.claude).toBe(
      `--model opus --append-system-prompt "keep ${CLAUDE_BYPASS} here"`
    )
  })

  it('leaves agents with a command override in Manual on a never-migrated profile', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({ agentCmdOverrides: { codex: '/opt/codex' } })
    )

    expect(profile.agentPermissionMode).toBe('bypass')
    expect(profile.agentPermissionModeOverrides).toEqual({ codex: 'ask' })
    expect(profile.agentDefaultArgs?.codex).toBe('')
  })

  it('keeps agents added after an older migration in Manual', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { claude: CLAUDE_BYPASS, codex: CODEX_BYPASS },
        agentDefaultEnv: {}
      })
    )

    expect(profile.agentPermissionMode).toBe('ask')
    expect(profile.agentPermissionModeOverrides).toEqual({ claude: 'bypass', codex: 'bypass' })
    expect(profile.agentDefaultArgs?.droid).toBe('')
  })

  it('updates the previous Devin default before lifting it', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { ...allYoloArgs(), devin: '--permission-mode bypass' },
        agentDefaultEnv: YOLO_ENV
      })
    )

    expect(profile.agentPermissionModeOverrides?.devin).toBeUndefined()
    expect(profile.agentDefaultArgs?.devin).toBe('')
  })

  it('is lossless: composing the result launches every agent with what it had', () => {
    const before = {
      ...allYoloArgs(),
      claude: `--model opus ${CLAUDE_BYPASS}`,
      codex: '-m o3',
      gemini: '',
      // Bypass beside another permission option: the launch must keep both.
      'claude-agent-teams': `${CLAUDE_BYPASS} --permission-mode plan`
    }
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: before,
        agentDefaultEnv: { goose: { GOOSE_MODE: 'auto', EXTRA: '1' } }
      })
    )
    const composed = composeTuiAgentLaunchArgsRecord(profile, DARWIN)

    for (const agent of PERMISSION_AGENT_IDS) {
      const original = resolveComposedTuiAgentLaunchArgs(agent, before).split(/\s+/).filter(Boolean)
      const after = (composed[agent] ?? '').split(/\s+/).filter(Boolean)
      expect([...after].sort()).toEqual([...original].sort())
    }
    expect(composeTuiAgentLaunchEnvRecord(profile).goose).toEqual({
      GOOSE_MODE: 'auto',
      EXTRA: '1'
    })
  })

  it('is idempotent: a typed profile loads unchanged', () => {
    const { profile: first } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { ...allYoloArgs(), claude: '--model opus' },
        agentDefaultEnv: YOLO_ENV
      })
    )
    const second = migrateAgentLaunchProfile(legacy({ ...first }))

    expect(second.migrated).toBe(false)
    expect(second.profile).toEqual(first)
  })

  // Why: the yolo-defaults pass reads the flag inline, so re-running it on typed extras would put
  // the Devin flag back into the free text.
  it('does not re-run the yolo-defaults pass on a typed profile', () => {
    const typed = legacy({
      agentYoloDefaultsMigrated: true,
      agentPermissionMode: 'ask',
      agentDefaultArgs: { devin: '--permission-mode bypass' }
    })
    const { profile } = migrateAgentLaunchProfile(typed)

    expect(profile.agentDefaultArgs?.devin).toBe('--permission-mode bypass')
    expect(profile.agentDefaultArgs?.droid).toBe('')
    expect(migrateAgentLaunchProfile(legacy({ ...typed, ...profile })).migrated).toBe(false)
  })

  // An older build reads a missing entry as "launch with the bypass flag".
  it('spells out every agent entry once, so a downgrade launches Manual', () => {
    const typed = legacy({ agentPermissionMode: 'ask', agentDefaultArgs: {}, agentDefaultEnv: {} })

    const first = migrateAgentLaunchProfile(typed)

    expect(first.migrated).toBe(true)
    for (const agent of PERMISSION_AGENT_IDS) {
      if (YOLO_TUI_AGENT_ARGS[agent] !== undefined) {
        expect(first.profile.agentDefaultArgs?.[agent]).toBe('')
      }
    }
    expect(first.profile.agentDefaultEnv).toEqual({ goose: {} })
    expect(migrateAgentLaunchProfile(legacy({ ...typed, ...first.profile })).migrated).toBe(false)
  })

  // An agent in Yolo through an alias launches Yolo, so it must not read as a Manual exception.
  it('reads a bypass alias as Yolo and keeps its text inline', () => {
    const aliases: [TuiAgent, string][] = [
      ['gemini', '-y'],
      ['claude', '--permission-mode bypassPermissions --model x'],
      ['devin', '--permission-mode bypass --model x'],
      ['codex', '-a never -s danger-full-access'],
      ['grok', '--permission-mode=bypassPermissions'],
      ['cline', '--auto-approve=true']
    ]
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { ...allYoloArgs(), ...Object.fromEntries(aliases) },
        agentDefaultEnv: YOLO_ENV
      })
    )

    expect(profile.agentPermissionMode).toBe('bypass')
    expect(profile.agentPermissionModeOverrides).toEqual({})
    for (const [agent, args] of aliases) {
      expect(profile.agentDefaultArgs?.[agent]).toBe(args)
      expect(resolveTuiAgentLaunchArgs(agent, profile, DARWIN)).toBe(args)
    }
  })

  // Lossless: a quoted flag stays in the text, launches once, and reads as Yolo, as main launched it.
  it.each([`--append-system-prompt "${CLAUDE_BYPASS}"`, `"${CLAUDE_BYPASS}"`])(
    'keeps quoted flag text %j inline',
    (claude) => {
      const { profile } = migrateAgentLaunchProfile(
        legacy({
          agentYoloDefaultsMigrated: true,
          agentDefaultArgs: { ...allYoloArgs(), claude },
          agentDefaultEnv: YOLO_ENV
        })
      )

      expect(profile.agentDefaultArgs?.claude).toBe(claude)
      expect(profile.agentPermissionModeOverrides).toEqual({})
      expect(resolveTuiAgentLaunchArgs('claude', profile, DARWIN)).toBe(claude)
    }
  )

  // After a downgrade, the older build's Yolo switch writes the flag back into every agent's text.
  it('lifts a flag an older build wrote back into a typed profile, on every load', () => {
    const typed = legacy({
      agentYoloDefaultsMigrated: true,
      agentPermissionMode: 'bypass',
      agentPermissionModeOverrides: { claude: 'ask', codex: 'ask' },
      agentDefaultArgs: {
        claude: '--model opus',
        codex: `${CODEX_BYPASS} -m o3`,
        gemini: '--yolo'
      },
      agentDefaultEnv: YOLO_ENV
    })

    const { profile, migrated } = migrateAgentLaunchProfile(typed)

    expect(migrated).toBe(true)
    expect(profile.agentPermissionMode).toBe('bypass')
    expect(profile.agentPermissionModeOverrides).toEqual({ claude: 'ask' })
    expect(profile.agentDefaultArgs).toMatchObject({ claude: '--model opus', codex: '-m o3' })
    expect(profile.agentDefaultArgs?.gemini).toBe('')
    expect(profile.agentDefaultEnv?.goose).toEqual({})
    const again = migrateAgentLaunchProfile(legacy({ ...typed, ...profile }))
    expect(again.migrated).toBe(false)
    expect(again.profile).toEqual(profile)
  })

  it('records a lifted flag as a Yolo override under a Manual default', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentPermissionMode: 'ask',
        agentDefaultArgs: { codex: CODEX_BYPASS, claude: '--permission-mode plan' }
      })
    )

    expect(profile.agentPermissionModeOverrides).toEqual({ codex: 'bypass' })
    expect(profile.agentDefaultArgs).toMatchObject({ codex: '', claude: '--permission-mode plan' })
  })

  // A newer build's modes stay for it; this build reads them as Manual and never re-migrates.
  it('keeps stored modes it does not know', () => {
    const stored: GlobalSettings = JSON.parse(
      JSON.stringify({
        agentYoloDefaultsMigrated: true,
        agentPermissionMode: 'accept-edits',
        agentPermissionModeOverrides: { codex: 'bypass', gemini: 'plan' },
        agentDefaultArgs: { claude: '--model opus' }
      })
    )

    const { profile } = migrateAgentLaunchProfile(stored)

    expect(profile.agentPermissionMode).toBe('accept-edits')
    expect(profile.agentPermissionModeOverrides).toEqual({ codex: 'bypass', gemini: 'plan' })
    expect(profile.agentDefaultArgs).toMatchObject({ claude: '--model opus', codex: '' })
    expect(migrateAgentLaunchProfile({ ...stored, ...profile }).migrated).toBe(false)
    const loaded = { ...stored, ...profile }
    expect(loaded.agentPermissionMode).toBe('accept-edits')
    expect(resolveAgentPermissionMode('claude', loaded)).toBe('ask')
    expect(resolveTuiAgentLaunchArgs('claude', loaded, DARWIN)).toBe('--model opus')
    expect(resolveAgentPermissionMode('gemini', loaded)).toBe('ask')
    expect(resolveTuiAgentLaunchArgs('gemini', loaded, DARWIN)).toBe('')
  })

  // An escaped flag means something different under each shell, so a load never cuts it.
  it.each([`--model opus \`${CLAUDE_BYPASS}`, `--model opus \\${CLAUDE_BYPASS}`])(
    'leaves the escaped flag %j in a typed profile on every load',
    (claude) => {
      const typed = legacy({ agentPermissionMode: 'ask', agentDefaultArgs: { claude } })
      const { profile } = migrateAgentLaunchProfile(typed)

      expect(profile.agentDefaultArgs?.claude).toBe(claude)
      expect(profile.agentPermissionModeOverrides).toEqual({})
    }
  )

  // POSIX keeps this flag inside the prompt (escaped quotes); PowerShell would split it out.
  it('keeps Manual for a flag one shell reads inside a quoted prompt, on every load', () => {
    const claude = `--append-system-prompt "Never run \\" ${CLAUDE_BYPASS} \\" yourself"`
    const typed = legacy({ agentPermissionMode: 'ask', agentDefaultArgs: { claude } })

    const first = migrateAgentLaunchProfile(typed)
    const again = migrateAgentLaunchProfile(legacy({ ...typed, ...first.profile }))

    expect(first.profile.agentDefaultArgs?.claude).toBe(claude)
    expect(first.profile.agentPermissionModeOverrides).toEqual({})
    expect(again.migrated).toBe(false)
    expect(resolveAgentPermissionMode('claude', again.profile)).toBe('ask')
  })
})
