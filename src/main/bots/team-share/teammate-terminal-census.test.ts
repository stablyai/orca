// The census of every place a terminal's events or facts reach a consumer on the host: each one is
// classified by the terminal's tab list (`tabListOfPty`) through one of the four shared readers, or
// named as a consumer that is no owner-side surface, with why. A new consumer fails here until it is
// placed, so no feed reaches the owner unclassified.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

/** The four readers of a terminal's list (`person-workspace-target.ts`, `terminal-tab-list-classification.ts`). */
type Reader = 'hostListPty' | 'windowShowsPty' | 'inHostListPane' | 'clientEventTabList'

type Row =
  | { reader: Reader; classifiedIn?: string; count?: number }
  | { notOwner: string; count?: number }

/** Where a terminal's events or facts leave for a consumer. `dirs` narrows a pattern too common
 *  elsewhere to the owner's feed layers (sidebar inputs and pushes). */
const SINKS: Record<string, { pattern: RegExp; dirs?: readonly string[] }> = {
  // Facts the owner's window mirrors.
  'notifier-fact': {
    pattern: /\bnotifier\??\.(terminalFitOverrideChanged|terminalDriverChanged)\(/g
  },
  // Acts on the owner's window, which the window relay refuses for a teammate's workspace.
  'notifier-act': {
    pattern: /\bnotifier\??\.(revealTerminalSession|resolveLegacyWorkerTerminalRecovery)\(/g
  },
  'tab-mount-request': { pattern: /'terminal:requestTabMount'/g },
  // The owner's window's own side-effect feed (bells, titles).
  'window-side-effects': { pattern: /\bonTerminalSideEffects\?\.\(/g },
  // What the owner's window hydrates from on reload.
  'window-hydration': { pattern: /\.getAll(TerminalFitOverrides|TerminalDrivers)\(\)/g },
  // Client-event bus listeners: the default takes the host lists' (`clientEventTabList`); these do not.
  'bus-every-list': { pattern: /tabLists: 'every'/g },
  'bus-caller-lists': { pattern: /\btabLists\b(?!: 'every')(?=[,\s}])/g },
  // The status detector: every pane's, or the host lists' alone (`inHostListPane`).
  'detector-every-pane': { pattern: /\b(agentTransitions|transitions)\.subscribe\(/g },
  'detector-host-lists': { pattern: /\.subscribeHostLists\(/g },
  'terminal-use': { pattern: /\.noteTerminalUse\(/g },
  'hook-pane-rows': {
    pattern: /\.getStatusSnapshotForPane\(/g,
    dirs: ['src/main/runtime/sidebar-inputs/', 'src/main/runtime/push/']
  },
  'pty-records-read': {
    pattern: /\bthis\.ptysById\.values\(\)/g,
    dirs: ['src/main/runtime/sidebar-inputs/', 'src/main/runtime/push/']
  }
}

const B_WINDOW_ACT = 'an act on the window, refused for a teammate’s workspace at the window relay'
const TRANSITIONS = 'src/main/runtime/construction/orca-runtime-agent-transitions.ts'

const CENSUS: Record<string, Record<string, Row>> = {
  'notifier-fact': {
    'src/main/runtime/terminal/lifecycle/terminal-view-resources.ts': { reader: 'windowShowsPty' },
    'src/main/runtime/terminal/layout/terminal-desktop-reclaim.ts': { reader: 'windowShowsPty' },
    'src/main/runtime/terminal/layout/terminal-layout-application.ts': { reader: 'windowShowsPty' },
    'src/main/runtime/terminal/lifecycle/pty-exit-lifecycle.ts': { reader: 'windowShowsPty' }
  },
  'notifier-act': {
    'src/main/runtime/orchestration/terminal-authority/legacy-worker-terminal-surface.ts': {
      notOwner: B_WINDOW_ACT
    },
    'src/main/runtime/terminal/focus/focus-terminal.ts': { notOwner: B_WINDOW_ACT },
    'src/main/runtime/terminal/launch/mobile-terminal-chat-fork-create.ts': {
      notOwner: B_WINDOW_ACT
    }
  },
  'tab-mount-request': {
    'src/main/runtime/terminal/view/renderer-terminal-snapshot.ts': { notOwner: B_WINDOW_ACT },
    // The window relay's own table of the acts it refuses for a teammate's workspace.
    'src/main/runtime/client/events/window-relay-guard.ts': { notOwner: B_WINDOW_ACT }
  },
  'window-side-effects': {
    'src/main/runtime/terminal/output/terminal-transient-facts.ts': { reader: 'hostListPty' }
  },
  'window-hydration': {
    'src/main/ipc/runtime.ts': {
      reader: 'windowShowsPty',
      classifiedIn: 'src/main/runtime/terminal/output/terminal-output-path.ts',
      count: 2
    }
  },
  'bus-every-list': {
    'src/main/runtime/sidebar-inputs/orca-runtime-sidebar-temporal.ts': {
      notOwner: 'the status detector’s feed, which splits the owner’s lists itself'
    },
    'src/main/runtime/workspaces/persisted-surfaces/crew-operations.ts': {
      notOwner: 'a crew’s workers, wherever they run'
    }
  },
  'bus-caller-lists': {
    'src/main/runtime/client/events/runtime-client-event-bus.ts': {
      reader: 'clientEventTabList',
      classifiedIn: 'src/main/runtime/construction/runtime-service-state.ts'
    },
    'src/main/runtime/rpc/methods/client-events/client-events.ts': {
      reader: 'clientEventTabList',
      classifiedIn: 'src/main/runtime/construction/runtime-service-state.ts',
      count: 2
    }
  },
  'detector-every-pane': {
    'src/main/bots/bot-change-notices.ts': { notOwner: 'a bot’s own Activity rows' },
    'src/main/external-conversations/external-conversations-install.ts': {
      notOwner: 'a connector conversation’s replies, to its asker'
    },
    'src/main/runtime/construction/orca-runtime-agent-questions.ts': {
      notOwner: 'an agent’s questions, to the session that asked it'
    },
    [TRANSITIONS]: { notOwner: 'orchestration worker turn stops and auto-release', count: 2 },
    'src/main/runtime/terminal/input/terminal-agent-prompt-submit.ts': {
      notOwner: 'a prompt send waiting on its own pane'
    },
    'src/main/runtime/workspaces/persisted-surfaces/crew-operations.ts': {
      notOwner: 'a crew’s workers, wherever they run'
    }
  },
  'detector-host-lists': {
    // The phone push.
    [TRANSITIONS]: { reader: 'inHostListPane' },
    'src/main/runtime/sidebar-inputs/temporal/sort-stamps-producer.ts': {
      reader: 'inHostListPane',
      classifiedIn: TRANSITIONS
    }
  },
  'terminal-use': {
    'src/main/runtime/rpc/methods/terminal/terminal-subscribe-method.ts': {
      reader: 'hostListPty',
      classifiedIn: 'src/main/runtime/sidebar-inputs/orca-runtime-sidebar-temporal.ts'
    },
    'src/main/runtime/sidebar-inputs/orca-runtime-sidebar-temporal.ts': { reader: 'hostListPty' }
  },
  'hook-pane-rows': {
    'src/main/runtime/sidebar-inputs/workspace-facts/workspace-activity-facts-producer.ts': {
      reader: 'inHostListPane',
      classifiedIn:
        'src/main/runtime/sidebar-inputs/workspace-facts/orca-runtime-workspace-activity-facts.ts'
    }
  },
  'pty-records-read': {
    'src/main/runtime/sidebar-inputs/orca-runtime-sidebar-temporal.ts': { reader: 'hostListPty' },
    'src/main/runtime/sidebar-inputs/workspace-facts/orca-runtime-workspace-activity-facts.ts': {
      reader: 'hostListPty',
      count: 2
    }
  }
}

const sources = execFileSync('git', ['ls-files', 'src/main/**/*.ts'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file && !/\.test\.ts$|test-support|fixture\.ts$/.test(file))
  .map((file) => ({ file, text: readFileSync(file, 'utf8') }))

it('places every consumer of a terminal’s events or facts', () => {
  const found: Record<string, Record<string, number>> = {}
  for (const [sink, { pattern, dirs }] of Object.entries(SINKS)) {
    found[sink] = {}
    for (const { file, text } of sources) {
      const count = [...text.matchAll(pattern)].length
      if (count > 0 && (!dirs || dirs.some((dir) => file.startsWith(dir)))) {
        found[sink][file] = count
      }
    }
  }
  const listed = Object.fromEntries(
    Object.entries(CENSUS).map(([sink, rows]) => [
      sink,
      Object.fromEntries(Object.entries(rows).map(([file, row]) => [file, row.count ?? 1]))
    ])
  )
  expect(found).toEqual(listed)
})

it('classifies each placed consumer through its reader', () => {
  const textOf = new Map(sources.map(({ file, text }) => [file, text]))
  for (const rows of Object.values(CENSUS)) {
    for (const [file, row] of Object.entries(rows)) {
      if ('reader' in row) {
        expect(textOf.get(row.classifiedIn ?? file), file).toMatch(
          new RegExp(`\\b${row.reader}\\b`)
        )
      } else {
        expect(row.notOwner.length, file).toBeGreaterThan(0)
      }
    }
  }
})
