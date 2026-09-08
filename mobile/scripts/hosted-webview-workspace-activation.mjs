import { activateHostedWebViewControl } from './hosted-webview-cdp-session.mjs'

export async function activateHostedWorkspaceRow(
  document,
  workspaceName,
  activateControl = activateHostedWebViewControl,
  timeoutMs = 30_000,
  resolveDocument
) {
  const deadline = Date.now() + timeoutMs
  let activeDocument = document
  let lastError
  while (Date.now() < deadline) {
    try {
      await activateHostedWorkspaceRowOnce(activeDocument, workspaceName, activateControl)
      return
    } catch (error) {
      if (isStaleDocument(error) && resolveDocument) {
        activeDocument = await resolveDocument()
        continue
      }
      if (isMissingControl(error) && resolveDocument) {
        const resolvedDocument = await resolveDocument()
        if (resolvedDocument.href !== activeDocument.href) {
          return
        }
        activeDocument = resolvedDocument
      }
      if (!isMissingControl(error)) {
        throw error
      }
      lastError = error
      await delay(250)
    }
  }
  throw new Error(
    `${lastError?.message ?? `Hosted WebView control was not found: ${workspaceName}`} (document ${activeDocument.href})`,
    { cause: lastError }
  )
}

async function activateHostedWorkspaceRowOnce(document, workspaceName, activateControl) {
  try {
    await activateControl(document, {
      kind: 'label',
      value: `Open ${workspaceName}`,
      reveal: true
    })
    return
  } catch (error) {
    if (!isMissingControl(error)) {
      throw error
    }
  }
  try {
    await activateControl(document, {
      kind: 'text',
      value: workspaceName,
      ignoreCase: true,
      occurrence: 1,
      reveal: true
    })
  } catch (error) {
    if (!isMissingControl(error)) {
      throw error
    }
    await activateControl(document, {
      kind: 'text',
      value: workspaceName,
      ignoreCase: true,
      reveal: true
    })
    await delay(250)
    try {
      await activateControl(document, {
        kind: 'text',
        value: workspaceName,
        ignoreCase: true,
        occurrence: 1,
        reveal: true
      })
    } catch (fallbackError) {
      if (isStaleDocument(fallbackError)) {
        return
      }
      throw fallbackError
    }
  }
}

function isMissingControl(error) {
  return error instanceof Error && error.message.includes('control was not found')
}

function isStaleDocument(error) {
  return (
    error instanceof Error &&
    (error.message.includes('CDP connection closed') ||
      error.message.includes('Unexpected server response: 500'))
  )
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
