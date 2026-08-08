import { randomBytes } from 'node:crypto'
import type {
  RuntimeTerminalClose,
  RuntimeTerminalCreate,
  RuntimeTerminalFocus,
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalRename,
  RuntimeTerminalSend,
  RuntimeTerminalShow,
  RuntimeTerminalSplit,
  RuntimeTerminalWait
} from '../../shared/runtime-types'
import type { RuntimeCreateAgentSessionResult } from '../../shared/agent-session-host-authority'
import type { ProviderAccountRef } from '../../shared/provider-account-ref'
import { AGENT_SESSION_ACCOUNT_REF_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { CodexRateLimitAccountsState } from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import { shouldUseRendererBackedInteractiveTerminal } from '../codex-command-classification'
import {
  formatTerminalClose,
  formatTerminalCreate,
  formatTerminalFocus,
  formatTerminalList,
  formatTerminalRead,
  formatTerminalRename,
  formatTerminalSend,
  formatTerminalShow,
  formatTerminalSplit,
  formatTerminalWait,
  printResult
} from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import {
  getBrowserWorktreeSelector,
  getOptionalWorktreeSelector,
  getRequiredWorktreeSelector,
  getTerminalHandle
} from '../selectors'

// Why: terminal wait legitimately needs to outlive the CLI's default RPC
// timeout. Even without an explicit server timeout, the client must allow
// long waits instead of failing at the generic 15s transport cap.
const DEFAULT_TERMINAL_WAIT_RPC_TIMEOUT_MS = 5 * 60 * 1000

function createCliAgentSessionOperationId(): string {
  return `${Date.now()}-${randomBytes(16).toString('hex')}`
}

async function resolveCodexLaunchAccountRef(
  client: RuntimeClient,
  flags: Map<string, string | boolean>
): Promise<ProviderAccountRef | null> {
  const readNewFlag = (name: string): string | undefined =>
    flags.has(name) ? getRequiredStringFlag(flags, name) : undefined
  const accountSelector = readNewFlag('account')
  const agent = readNewFlag('agent')
  const accountRuntime = readNewFlag('account-runtime')
  const wslDistro = readNewFlag('wsl-distro')
  if (accountSelector === undefined) {
    if (agent !== undefined || accountRuntime !== undefined || wslDistro !== undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--agent, --account-runtime, and --wsl-distro require --account.'
      )
    }
    return null
  }
  if (agent !== 'codex') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Codex account launches require `--agent codex`.'
    )
  }
  const status = await client.call<{ capabilities?: string[] }>('status.get')
  if (!status.result.capabilities?.includes(AGENT_SESSION_ACCOUNT_REF_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime does not support account-scoped agent launches. Update or restart Orca and try again.'
    )
  }
  if (accountSelector === 'system') {
    const runtime = accountRuntime ?? 'host'
    if (runtime !== 'host' && runtime !== 'wsl') {
      throw new RuntimeClientError('invalid_argument', '--account-runtime must be "host" or "wsl".')
    }
    if ((runtime === 'wsl') !== Boolean(wslDistro)) {
      throw new RuntimeClientError(
        'invalid_argument',
        'A WSL system account requires --wsl-distro, and a host account cannot use it.'
      )
    }
    return {
      provider: 'codex',
      accountId: null,
      runtime,
      ...(wslDistro ? { wslDistro } : {})
    }
  }
  if (accountRuntime !== undefined || wslDistro !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Managed account UUIDs already identify their runtime; omit --account-runtime and --wsl-distro.'
    )
  }
  const accounts = await client.call<{ codex: CodexRateLimitAccountsState }>('accounts.list', {
    refreshUsage: false
  })
  const account = accounts.result.codex.accounts.find(
    (candidate) => candidate.id === accountSelector
  )
  if (!account) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown Codex account UUID "${accountSelector}". Run \`orca account list\` to see canonical selectors.`
    )
  }
  const runtime = account.managedHomeRuntime ?? 'host'
  const managedWslDistro = account.wslDistro?.trim()
  if (runtime === 'wsl' && !managedWslDistro) {
    throw new RuntimeClientError(
      'invalid_state',
      `Codex account "${account.id}" has no WSL distribution. Re-register the account before launching it.`
    )
  }
  return {
    provider: 'codex',
    accountId: account.id,
    runtime,
    ...(runtime === 'wsl' ? { wslDistro: managedWslDistro } : {})
  }
}

const terminalFocusHandler: CommandHandler = async ({ flags, client, cwd, json }) => {
  const result = await client.call<{ focus: RuntimeTerminalFocus }>('terminal.focus', {
    terminal: await getTerminalHandle(flags, cwd, client),
    navigation: 'host'
  })
  printResult(result, json, formatTerminalFocus)
}

export const TERMINAL_HANDLERS: Record<string, CommandHandler> = {
  'terminal list': async ({ flags, client, cwd, json }) => {
    const result = await client.call<RuntimeTerminalListResult>('terminal.list', {
      worktree: await getOptionalWorktreeSelector(flags, 'worktree', cwd, client),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      // Why: agent JSON calls dominate; topology stays available through an explicit opt-in.
      includeVisualLayouts: !json || flags.has('include-visual-layouts')
    })
    printResult(result, json, formatTerminalList)
  },
  'terminal show': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', {
      terminal: await getTerminalHandle(flags, cwd, client)
    })
    printResult(result, json, formatTerminalShow)
  },
  'terminal read': async ({ flags, client, cwd, json }) => {
    const cursorFlag = getOptionalStringFlag(flags, 'cursor')
    const cursor =
      cursorFlag !== undefined && /^\d+$/.test(cursorFlag)
        ? Number.parseInt(cursorFlag, 10)
        : undefined
    if (cursorFlag !== undefined && cursor === undefined) {
      throw new RuntimeClientError('invalid_argument', '--cursor must be a non-negative integer')
    }
    const result = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
      terminal: await getTerminalHandle(flags, cwd, client),
      ...(cursor !== undefined ? { cursor } : {}),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatTerminalRead)
  },
  'terminal send': async ({ flags, client, cwd, json }) => {
    const text = getOptionalStringFlag(flags, 'text')
    const enter = flags.get('enter') === true
    const interrupt = flags.get('interrupt') === true
    const result = await client.call<{ send: RuntimeTerminalSend }>('terminal.send', {
      terminal: await getTerminalHandle(flags, cwd, client),
      text,
      enter,
      interrupt,
      ...(text && enter && !interrupt ? { agentPrompt: true } : {}),
      client: { id: 'orca-cli', type: 'desktop' }
    })
    printResult(result, json, formatTerminalSend)
  },
  'terminal wait': async ({ flags, client, cwd, json }) => {
    const timeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout-ms')
    const result = await client.call<{ wait: RuntimeTerminalWait }>(
      'terminal.wait',
      {
        terminal: await getTerminalHandle(flags, cwd, client),
        for: getRequiredStringFlag(flags, 'for'),
        timeoutMs
      },
      {
        timeoutMs: timeoutMs ? timeoutMs + 5000 : DEFAULT_TERMINAL_WAIT_RPC_TIMEOUT_MS
      }
    )
    printResult(result, json, formatTerminalWait)
    if (result.result.wait.satisfied === false) {
      // Why: callers commonly chain `terminal wait && terminal send`; a
      // structured blocked result is still an unsatisfied wait condition.
      process.exitCode = 1
    }
  },
  'terminal stop': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ stopped: number }>('terminal.stop', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    })
    printResult(result, json, (value) => `Stopped ${value.stopped} terminals.`)
  },
  'terminal rename': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ rename: RuntimeTerminalRename }>('terminal.rename', {
      terminal: await getTerminalHandle(flags, cwd, client),
      title: getOptionalStringFlag(flags, 'title') ?? null
    })
    printResult(result, json, formatTerminalRename)
  },
  'terminal create': async ({ flags, client, cwd, json }) => {
    if (client.isRemote && !flags.has('worktree')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Remote terminal create requires --worktree because the client cwd cannot identify a server worktree.'
      )
    }
    const command = getOptionalStringFlag(flags, 'command')
    const providerAccountRef = await resolveCodexLaunchAccountRef(client, flags)
    const title = getOptionalStringFlag(flags, 'title')
    const useRendererBackedInteractiveTerminal =
      !client.isRemote && shouldUseRendererBackedInteractiveTerminal(command)
    const focus = flags.get('focus') === true
    if (providerAccountRef) {
      if (command !== undefined || title !== undefined) {
        throw new RuntimeClientError(
          'invalid_argument',
          '--account builds the Codex launch on the runtime; omit --command and --title.'
        )
      }
      const result = await client.call<RuntimeCreateAgentSessionResult>(
        'terminal.createAgentSession',
        {
          clientOperationId: createCliAgentSessionOperationId(),
          worktree: await getBrowserWorktreeSelector(flags, cwd, client),
          agent: 'codex',
          providerAccountRef,
          presentation: focus ? 'focused' : 'background'
        }
      )
      printResult(result, json, formatTerminalCreate)
      return
    }
    const result = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
      worktree: await getBrowserWorktreeSelector(flags, cwd, client),
      command,
      title,
      // Why: interactive local agent TUIs need the renderer-backed terminal
      // path for browser-side features, but CLI creates must stay backgrounded
      // unless the caller explicitly asks for focus.
      focus,
      ...(focus ? { presentation: 'focused' } : {}),
      ...(useRendererBackedInteractiveTerminal ? { rendererBacked: true, activate: focus } : {})
    })
    printResult(result, json, formatTerminalCreate)
  },
  // `focus` resolves to this canonical path via CommandSpec.aliases before dispatch.
  'terminal switch': terminalFocusHandler,
  'terminal close': async ({ flags, client, cwd, json }) => {
    const method = flags.get('tab') === true ? 'terminal.closeTab' : 'terminal.close'
    const result = await client.call<{ close: RuntimeTerminalClose }>(method, {
      terminal: await getTerminalHandle(flags, cwd, client)
    })
    printResult(result, json, formatTerminalClose)
  },
  'terminal split': async ({ flags, client, cwd, json }) => {
    const directionFlag = getOptionalStringFlag(flags, 'direction')
    if (
      directionFlag !== undefined &&
      directionFlag !== 'horizontal' &&
      directionFlag !== 'vertical'
    ) {
      throw new RuntimeClientError('invalid_argument', '--direction must be horizontal or vertical')
    }
    const result = await client.call<{ split: RuntimeTerminalSplit }>('terminal.split', {
      terminal: await getTerminalHandle(flags, cwd, client),
      direction: directionFlag,
      command: getOptionalStringFlag(flags, 'command')
    })
    printResult(result, json, formatTerminalSplit)
  }
}
