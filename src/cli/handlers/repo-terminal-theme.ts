import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import {
  buildRepoTerminalThemeUpdate,
  normalizeRepoTerminalThemeOverrides
} from '../../shared/repo-terminal-theme'
import type { CommandHandler } from '../dispatch'
import { formatRepoShow, printResult } from '../format'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'

export const setRepoTerminalTheme: CommandHandler = async ({ flags, client, json }) => {
  const repo = getRequiredStringFlag(flags, 'repo')
  const mode = getRequiredStringFlag(flags, 'mode')
  const theme = getRequiredStringFlag(flags, 'theme').trim()
  if (mode !== 'dark' && mode !== 'light') {
    throw new RuntimeClientError('invalid_argument', '--mode must be dark or light.')
  }
  const requested = buildRepoTerminalThemeUpdate(
    undefined,
    mode,
    theme === 'inherit' ? null : theme
  )
  if (!theme || requested.kind === 'rejected') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--theme must be a non-empty, storable theme selection or inherit.'
    )
  }
  const current = await client.call<{ repo: Repo }>('repo.show', { repo })
  if (parseExecutionHostId(getRepoExecutionHostId(current.result.repo))?.kind === 'runtime') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Project terminal themes are not supported for paired-runtime repo rows.'
    )
  }
  const pick = normalizeRepoTerminalThemeOverrides(current.result.repo.terminalTheme)
  const update = buildRepoTerminalThemeUpdate(pick, mode, theme === 'inherit' ? null : theme)
  if (update.kind === 'rejected') {
    throw new RuntimeClientError('invalid_argument', '--theme cannot be stored.')
  }
  const result = await client.call<{ repo: Repo }>('repo.update', {
    repo,
    updates: { terminalTheme: update.terminalTheme }
  })
  const saved = normalizeRepoTerminalThemeOverrides(result.result.repo.terminalTheme)
  // Older runtimes can strip terminalTheme without rejecting the update.
  if (saved?.dark !== update.terminalTheme?.dark || saved?.light !== update.terminalTheme?.light) {
    throw new RuntimeClientError(
      'unsupported_operation',
      'The runtime did not save the requested terminal theme. Update Orca on that host and retry.'
    )
  }
  printResult(result, json, formatRepoShow)
}
