import { randomUUID } from 'node:crypto'
import {
  activateHostedWebViewControl,
  readHostedWebViewState,
  setHostedWebViewInput,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'

export async function verifyHostedSessionActions({
  discoveryUrl,
  timeoutMs,
  document,
  originalTitle,
  readTerminals,
  longPress
}) {
  const initialTerminals = await readTerminals()
  const initialHandles = new Set(initialTerminals.map((terminal) => terminal.handle))
  const initial = await readHostedWebViewState(document)
  const count = Number(initial.bodyText.match(/\b(\d+) tabs?\b/)?.[1])
  if (!count) {
    throw new Error('Session fixture has no initial tab count')
  }
  const wait = (expectedText) =>
    waitForVisibleHostedWebView({
      discoveryUrl,
      timeoutMs,
      expectedHrefIncludes: '/session/',
      expectedText
    })
  await activateHostedWebViewControl(document, { kind: 'label', value: 'New tab' })
  document = await wait('New Tab')
  await activateHostedWebViewControl(document, { kind: 'text', value: 'Terminal', reveal: true })
  document = await wait(`${count + 1} tabs`)
  const created = await waitForTerminals(
    readTerminals,
    (terminals) => terminals.find((terminal) => !initialHandles.has(terminal.handle)),
    timeoutMs
  )
  await longPress(document, created.title || 'Terminal')
  document = await wait('Rename')
  await activateHostedWebViewControl(document, { kind: 'text', value: 'Rename' })
  document = await wait('Rename Terminal')
  const title = `Fixture ${randomUUID().slice(0, 8)}`
  await setHostedWebViewInput(document, { placeholder: 'Terminal name', value: title })
  await activateHostedWebViewControl(document, { kind: 'text', value: 'Save' })
  document = await wait(title)
  await waitForTerminals(
    readTerminals,
    (terminals) =>
      terminals.find((terminal) => terminal.handle === created.handle && terminal.title === title),
    timeoutMs
  )
  await activateHostedWebViewControl(document, { kind: 'text', value: originalTitle })
  await activateHostedWebViewControl(document, { kind: 'text', value: title })
  await longPress(document, title)
  document = await wait('Close')
  await activateHostedWebViewControl(document, { kind: 'text', value: 'Close' })
  document = await wait(`${count} ${count === 1 ? 'tab' : 'tabs'}`)
  await waitForTerminals(
    readTerminals,
    (terminals) => !terminals.some((terminal) => terminal.handle === created.handle),
    timeoutMs
  )
  const after = await readHostedWebViewState(document)
  if (after.bodyText.includes(title)) {
    throw new Error('Closed session tab remains published')
  }
  await activateHostedWebViewControl(document, { kind: 'text', value: originalTitle })
  return {
    document,
    evidence: {
      createdTerminal: true,
      renamedTerminal: true,
      activatedTabs: true,
      closedCreatedTab: true,
      hostCreateRenameCloseConfirmed: true,
      originalTabCountRestored: true
    }
  }
}

async function waitForTerminals(read, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = predicate(await read())
    if (result) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Session action was not reflected by the owning Desktop terminal inventory')
}
