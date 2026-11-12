import type {
  BrowserExtensionSummaryListResult,
  BrowserExtensionReloadResult
} from '../../shared/browser/extensions/browser-extension-types'
import type { CommandHandler } from '../dispatch'
import { getPresentStringFlag } from '../flags'
import { printResult } from '../command-result-output'
import { resolveRepoPathArgument } from '../projects/repo-path-arguments'

export const BROWSER_EXTENSION_HANDLERS: Record<string, CommandHandler> = {
  'extension list': async ({ flags, client, json }) => {
    const profileId = getPresentStringFlag(flags, 'profile')
    const result = await client.call<BrowserExtensionSummaryListResult>(
      'browser.extensionList',
      profileId !== undefined ? { profileId } : {}
    )
    printResult(result, json, ({ active, extensions }) =>
      !active
        ? 'Browser extensions are turned off in Settings › Browser › Extensions.'
        : extensions.length === 0
          ? 'No browser extensions installed.'
          : extensions
              .map(
                (extension) =>
                  `${extension.id}\t${extension.name}\t${extension.version}\t${extension.enabled ? 'enabled' : 'disabled'}\t${extension.source}\t${extension.path}`
              )
              .join('\n')
    )
  },
  'extension reload': async ({ flags, client, cwd, json }) => {
    const extensionId = getPresentStringFlag(flags, 'extension-id')
    const path = getPresentStringFlag(flags, 'path')
    const result = await client.call<BrowserExtensionReloadResult>('browser.extensionReload', {
      ...(extensionId !== undefined ? { extensionId } : {}),
      ...(path !== undefined
        ? {
            path: resolveRepoPathArgument(path, cwd, client.isRemote, 'Remote extension source')
          }
        : {})
    })
    printResult(
      result,
      json,
      (value) => `Reloaded extension ${value.extensionId} across all profiles where it is enabled.`
    )
  }
}
