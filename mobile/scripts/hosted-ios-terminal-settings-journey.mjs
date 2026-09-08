import path from 'node:path'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  setHostedWebViewInput
} from './hosted-webview-cdp-session.mjs'
import { openHostedIosSettings, closeHostedIosSettings } from './hosted-ios-settings-navigation.mjs'
import { waitHostedSettingsPickerOption } from './hosted-settings-picker-option.mjs'
import { verifyHostedIosTerminalPreferenceConsumer } from './hosted-ios-terminal-preference-consumer.mjs'
import { captureAgentHistorySimulatorScreenshot as captureScreenshot } from './hosted-ios-agent-history-parity.mjs'

const autocompleteLabel = 'Autocomplete and autocorrect'

export async function verifyHostedIosTerminalSettings(args) {
  const open = (document) =>
    openHostedIosSettings(args, document, 'Terminal', '/terminal-settings', 'for this paired host')
  let settings = await open(args.workspaceDocument)
  const original = await waitSettings(settings, {}, args.timeoutMs)
  const targetSize = original.textSize === 'Large (125%)' ? 'Smaller (75%)' : 'Large (125%)'
  const targetAutocomplete = !original.autocomplete
  const shortcutLabel = `OTA-${Date.now() % 1_000_000}`
  await chooseSize(settings, targetSize, args.timeoutMs)
  await activateHostedWebViewControl(settings, {
    kind: 'label',
    value: autocompleteLabel,
    reveal: true
  })
  await waitSettings(
    settings,
    { textSize: targetSize, autocomplete: targetAutocomplete },
    args.timeoutMs
  )
  await addShortcut(settings, shortcutLabel, args.timeoutMs)
  settings = await open(await closeHostedIosSettings(args, settings))
  const changed = await waitSettings(
    settings,
    {
      textSize: targetSize,
      autocomplete: targetAutocomplete,
      shortcutLabel,
      shortcutPresent: true
    },
    args.timeoutMs
  )
  await evaluateHostedDocumentWithRetry(
    settings,
    `document.querySelector('[aria-label="${autocompleteLabel}"]').scrollIntoView({block:'center'}); 'ok'`
  )
  const screenshot = path.join(args.runtimeDirectory, 'hosted-terminal-settings.png')
  await captureScreenshot(args.deviceUdid, screenshot)
  const consumer = await verifyHostedIosTerminalPreferenceConsumer(
    { ...args, workspaceDocument: await closeHostedIosSettings(args, settings) },
    {
      fontSize: fontSizeForLabel(targetSize),
      autocomplete: targetAutocomplete,
      shortcutLabel,
      shortcutPresent: true
    }
  )
  settings = await open(consumer.workspaceDocument)
  await chooseSize(settings, original.textSize, args.timeoutMs)
  await waitSettings(settings, {}, args.timeoutMs)
  await activateHostedWebViewControl(settings, {
    kind: 'label',
    value: autocompleteLabel,
    reveal: true
  })
  await waitSettings(settings, { autocomplete: original.autocomplete }, args.timeoutMs)
  await activateHostedWebViewControl(settings, {
    kind: 'label',
    value: `Delete ${shortcutLabel}`,
    reveal: true
  })
  await waitSettings(settings, { shortcutLabel, shortcutPresent: false }, args.timeoutMs)
  settings = await open(await closeHostedIosSettings(args, settings))
  const restored = await waitSettings(
    settings,
    {
      textSize: original.textSize,
      autocomplete: original.autocomplete,
      shortcutLabel,
      shortcutPresent: false
    },
    args.timeoutMs
  )
  const restoredConsumer = await verifyHostedIosTerminalPreferenceConsumer(
    { ...args, workspaceDocument: await closeHostedIosSettings(args, settings) },
    {
      fontSize: fontSizeForLabel(original.textSize),
      autocomplete: original.autocomplete,
      shortcutLabel,
      shortcutPresent: false
    }
  )
  return {
    workspaceDocument: restoredConsumer.workspaceDocument,
    evidence: {
      persistenceAfterReopen: true,
      original,
      changed,
      consumer: consumer.evidence,
      restored,
      restoredConsumer: restoredConsumer.evidence,
      screenshot
    }
  }
}

async function chooseSize(document, label, timeoutMs) {
  await waitSettings(document, {}, timeoutMs)
  await activateHostedWebViewControl(document, { kind: 'label', value: 'Text size', reveal: true })
  await waitHostedSettingsPickerOption(document, label, timeoutMs)
  await activateHostedWebViewControl(document, { kind: 'text', value: label })
  await waitSettings(document, { textSize: label }, timeoutMs)
}

async function addShortcut(document, label, timeoutMs) {
  await activateHostedWebViewControl(document, {
    kind: 'label',
    value: 'Add custom shortcut',
    reveal: true
  })
  await waitHostedSettingsPickerOption(document, 'Text Macro', timeoutMs)
  await activateHostedWebViewControl(document, { kind: 'text', value: 'Text Macro' })
  await waitHostedSettingsPickerOption(document, 'Add Shortcut', timeoutMs)
  await setHostedWebViewInput(document, { placeholder: 'e.g. Build', value: label })
  await setHostedWebViewInput(document, { placeholder: 'e.g. pnpm build', value: ':' })
  await activateHostedWebViewControl(document, { kind: 'text', value: 'Add Shortcut' })
  await waitSettings(document, { shortcutLabel: label, shortcutPresent: true }, timeoutMs)
}

async function waitSettings(document, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    state = JSON.parse(
      await evaluateHostedDocumentWithRetry(
        document,
        `(() => {
      const error=Array.from(document.querySelectorAll('[role="alert"]')).find(e=>e.textContent.includes('Could not'));
      if(error) throw new Error(error.textContent);
      const size=document.querySelector('[aria-label="Text size"]');
      const autocomplete=document.querySelector('[aria-label="${autocompleteLabel}"]');
      const add=document.querySelector('[aria-label="Add custom shortcut"]');
      const ready=[size,autocomplete,add].every(e=>e&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&e.getAttribute('aria-busy')!=='true');
      return JSON.stringify({ready,
        textSize:size?.textContent.match(/(?:Smallest|Smaller|Default|Larger|Largest|Large) \\(\\d+%\\)/)?.[0],
        autocomplete:autocomplete?.getAttribute('aria-checked')==='true'||autocomplete?.checked===true||autocomplete?.querySelector('input')?.checked===true,
        shortcutPresent:Boolean(document.querySelector(${JSON.stringify(`[aria-label="Delete ${expected.shortcutLabel ?? ''}"]`)}))});
    })()`
      )
    )
    if (
      state.ready &&
      state.textSize &&
      (expected.textSize === undefined || state.textSize === expected.textSize) &&
      (expected.autocomplete === undefined || state.autocomplete === expected.autocomplete) &&
      (expected.shortcutPresent === undefined || state.shortcutPresent === expected.shortcutPresent)
    ) {
      return state
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Terminal preferences did not load or persist: ${JSON.stringify(state)}`)
}

function fontSizeForLabel(label) {
  const percent = Number(label.match(/\((\d+)%\)/)?.[1])
  if (!Number.isFinite(percent) || percent <= 0) {
    throw new Error(`Unexpected terminal text size: ${label}`)
  }
  return (13 * percent) / 100
}
