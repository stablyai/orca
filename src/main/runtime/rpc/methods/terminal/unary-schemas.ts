import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../../schemas'
import { TERMINAL_PANE_SPLIT_SOURCES } from '../../../../../shared/feature-education-telemetry'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'

export const TerminalHandle = z.object({
  terminal: requiredString('Missing terminal handle'),
  // Additive fence understood by newer hosts; legacy hosts safely ignore it.
  expectedIncarnationId: requiredString('Missing PTY incarnation').optional()
})

export const TerminalFocus = TerminalHandle.extend({
  navigation: z.enum(['caller', 'host']).optional()
})

export const TerminalListParams = z.object({
  worktree: OptionalString,
  limit: OptionalFiniteNumber,
  handles: z
    .array(requiredString('Missing terminal handle').pipe(z.string().max(256)))
    .max(64)
    .optional(),
  requireFreshPtyLiveness: z.boolean().optional(),
  // Why: layouts are ~31% of a large listing and only the human CLI formatter
  // reads them. Absent means "include" so pre-flag clients keep rendering them.
  includeVisualLayouts: z.boolean().optional()
})

export const TerminalResolveActive = z.object({
  worktree: OptionalString
})

export const TerminalResolvePane = z.object({
  paneKey: requiredString('Missing pane key'),
  worktreeId: OptionalString
})

export const TerminalRecoverPane = z.object({
  paneKey: requiredString('Missing pane key'),
  worktreeId: requiredString('Missing worktree ID'),
  expectedTerminal: requiredString('Missing expected terminal handle').optional()
})

export const TerminalRead = TerminalHandle.extend({
  cursor: z
    .unknown()
    .transform((value) => {
      if (value === undefined) {
        return undefined
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return Number.NaN
      }
      return value
    })
    .pipe(
      z
        .number()
        .optional()
        .refine((v) => v === undefined || Number.isFinite(v), {
          message: 'Cursor must be a non-negative integer'
        })
    )
    .optional(),
  limit: OptionalFiniteNumber,
  // Why: optional so an older host that does not understand it simply drops the key and answers
  // with its usual stream read; the response's `source` is what tells the caller which it got.
  screen: z.literal(true).optional()
}).refine((params) => !(params.screen === true && params.cursor !== undefined), {
  // Why: a cursor pages through accumulated output; a screen is the current frame with nothing
  // behind it. Honoring both would answer with rendered lines carrying the stream's pagination
  // metadata — two frames of reference in one payload, which is the confusion `source` exists to
  // remove. The CLI already refuses the pair, but the RPC is reachable without it.
  message: 'Cursor cannot be combined with a screen read'
})

// Why: preserve the legacy contract — `title: string | null` only, `undefined` rejected, so the CLI's "reset" signal stays distinct.
export const TerminalRename = TerminalHandle.extend({
  title: z.custom<string | null>((value) => value === null || typeof value === 'string', {
    message: 'Missing --title (pass empty string or null to reset)'
  })
})

export const TerminalSend = TerminalHandle.extend({
  text: OptionalString,
  enter: z.unknown().optional(),
  interrupt: z.unknown().optional(),
  // Why: older hosts strip this optional intent and retain their direct-send behavior.
  agentPrompt: z.literal(true).optional(),
  resolvedLaunchDraft: z
    .object({
      text: z.string(),
      createdAt: z.number().finite()
    })
    .optional(),
  requireAgentStatus: z.enum(['sendable']).optional(),
  // Why: terminal-generated replies are valid input but must not transfer the shared terminal floor.
  inputKind: z.enum(['query-reply']).optional(),
  // Why: identifies the caller for the driver state machine; when absent (older clients) the server falls back to the most recent mobile actor (docs/mobile-presence-lock.md).
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop').optional()
    })
    .optional(),
  viewport: z
    .object({
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(500)
    })
    .optional(),
  claimViewport: z.literal(true).optional()
})

export const TerminalViewport = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500)
})

export const TerminalWait = TerminalHandle.extend({
  for: z.custom<'exit' | 'tui-idle'>((value) => value === 'exit' || value === 'tui-idle', {
    message: 'Invalid --for value. Supported: exit, tui-idle'
  }),
  timeoutMs: OptionalFiniteNumber
})

export const TerminalCreateParams = z.object({
  worktree: OptionalString,
  clientMutationId: z.string().min(1).max(128).optional(),
  reconcileExisting: z.boolean().optional(),
  command: OptionalString,
  startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
  env: z.record(z.string(), z.string()).optional(),
  envToDelete: z.array(z.string().min(1).max(256)).max(32).optional(),
  launchConfig: z
    .object({
      agentCommand: z.string().optional(),
      agentArgs: z.string(),
      agentEnv: z.record(z.string(), z.string()),
      ompResumeFilePath: z
        .string()
        .min(1)
        .max(32 * 1024)
        .optional()
    })
    .optional(),
  resumeProviderSession: z
    .object({
      key: z.enum(['session_id', 'conversation_id']),
      id: z.string().min(1).max(512),
      transcriptPath: z.string().min(1).max(32_768).optional()
    })
    .optional(),
  launchToken: OptionalString,
  launchAgent: z.string().refine(isTuiAgent).optional(),
  terminalColorQueryReplies: z
    .object({
      foreground: z.string().max(128).optional(),
      background: z.string().max(128).optional()
    })
    .optional(),
  title: OptionalString,
  focus: z.unknown().optional(),
  rendererBacked: z.unknown().optional(),
  activate: z.unknown().optional(),
  presentation: z.enum(['background', 'focused']).optional(),
  tabId: OptionalString,
  leafId: OptionalString
})

export const TerminalSplit = TerminalHandle.extend({
  direction: z
    .unknown()
    .transform((v) => (v === 'vertical' || v === 'horizontal' ? v : undefined))
    .pipe(z.union([z.enum(['vertical', 'horizontal']), z.undefined()]))
    .optional(),
  command: OptionalString,
  env: z.record(z.string(), z.string()).optional(),
  telemetrySource: z.enum(TERMINAL_PANE_SPLIT_SOURCES).optional()
})

export const TerminalStop = z.object({
  worktree: requiredString('Missing worktree selector')
})

export const TerminalCloseAll = TerminalStop

export const TerminalSleep = TerminalStop

export const TerminalStopExact = TerminalStop.extend({
  expectedPtyIds: z.array(requiredString('Missing PTY ID')).min(1),
  keepHistory: z.boolean().optional(),
  targetOnly: z.boolean().optional()
})

export const AgentTeamsTmuxCompat = z.object({
  teamId: requiredString('Missing agent team ID'),
  token: requiredString('Missing agent team token'),
  envPane: requiredString('Missing tmux pane identity'),
  cwd: OptionalString,
  argv: z.array(z.string())
})

export const AgentTeamsPrepareLaunch = z.object({
  paneKey: requiredString('Missing pane key'),
  env: z.record(z.string(), z.string()).optional()
})
