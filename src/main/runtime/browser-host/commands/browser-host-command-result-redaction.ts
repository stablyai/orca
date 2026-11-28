import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientAutomationResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { expectedUrlMismatchMessage } from '../../../../shared/browser/client-hosting/browser-expected-url'
import { redactKagiSessionToken } from '../../../../shared/browser/navigation/browser-url'
import { redactBrowserExpectedUrlMismatch } from '../../../browser/cdp/input/browser-expected-page-url'
import { redactClientBrowserAutomationResult } from '../../browser/client-pages/browser-client-automation-result-metadata'
import { redactClientNavigationFailureDetail } from '../../browser/client-pages/browser-client-navigation-failure'

export function redactBrowserHostCommandResult(
  command: BrowserClientHostCommandEvent['command'],
  result: BrowserClientAutomationResult
): BrowserClientAutomationResult {
  if (result.status === 'completed') {
    const value =
      command.type === 'automation'
        ? redactClientBrowserAutomationResult(command.method, result.value, command.params)
        : command.type === 'navigate' && typeof result.value === 'string'
          ? redactKagiSessionToken(result.value)
          : result.value
    return value === result.value ? result : { ...result, value }
  }
  const expectedUrlMismatch = result.expectedUrlMismatch
    ? redactBrowserExpectedUrlMismatch(result.expectedUrlMismatch)
    : undefined
  const errorMessage = expectedUrlMismatch
    ? expectedUrlMismatchMessage(expectedUrlMismatch)
    : command.type === 'automation'
      ? redactClientNavigationFailureDetail(command.method, command.params, result.errorMessage)
      : command.type === 'navigate' ||
          command.type === 'restorePage' ||
          command.type === 'createPage'
        ? redactClientNavigationFailureDetail(
            'browser.goto',
            {
              url: command.type === 'createPage' ? command.initialUrl : command.url
            },
            result.errorMessage
          )
        : result.errorMessage
  return {
    ...result,
    ...(errorMessage === result.errorMessage ? {} : { errorMessage }),
    ...(expectedUrlMismatch ? { expectedUrlMismatch } : {})
  }
}
