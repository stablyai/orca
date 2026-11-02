import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { BrowserError } from '../browser/browser-error'
import {
  FILL_ELEMENT_FUNCTION,
  SELECT_ALL_ELEMENT_FUNCTION,
  SELECT_OPTION_TARGET_FUNCTION
} from '../browser/browser-element-functions'
import { typedInputSteps } from '../browser/cdp-keyboard-us-layout'
import {
  agentBrowserError,
  agentBrowserEvalCommand,
  type AgentBrowserStep,
  type ExternalChromiumBrowserSession
} from './external-chromium-browser-session'

const ElementCallResult = z.object({
  result: z.object({ reached: z.boolean(), outcome: z.unknown().optional() })
})

// Bounds how long one helper process runs while typing.
const MAX_KEY_COMMANDS_PER_RUN = 256

// agent-browser owns the only CDP connection, so Orca reaches the element behind a ref through the
// helper's own `get attr` call on it: getAttribute is wrapped to record `this` for one unique name.
function captureScript(key: string): string {
  return `(() => {
  const state = { element: null, hooks: [] };
  // Published before any wrap, so the unwrap step always finds what to restore.
  Object.defineProperty(window, ${JSON.stringify(key)}, { value: state, configurable: true });
  const wrap = (win) => {
    try {
      const proto = win.Element.prototype;
      const original = proto.getAttribute;
      const hook = function (name) {
        if (name === ${JSON.stringify(key)}) state.element = this;
        return original.apply(this, arguments);
      };
      proto.getAttribute = hook;
      state.hooks.push([proto, original, hook]);
    } catch {}
    // A cross-origin frame can still hold frames of this page's origin.
    for (let index = 0; index < win.frames.length; index++) wrap(win.frames[index]);
  };
  wrap(window);
})()`
}

// Unwraps first, so the page is restored even when the element function throws.
function callScript(key: string, functionDeclaration: string, args: unknown[]): string {
  return `(() => {
  const state = window[${JSON.stringify(key)}];
  if (!state) return { reached: false };
  delete window[${JSON.stringify(key)}];
  for (const [proto, original, hook] of state.hooks) {
    if (proto.getAttribute === hook) proto.getAttribute = original;
  }
  if (!state.element) return { reached: false };
  return { reached: true, outcome: (${functionDeclaration}).apply(state.element, ${JSON.stringify(args)}) };
})()`
}

function stepResult(step: AgentBrowserStep | undefined): unknown {
  if (!step?.success) {
    throw agentBrowserError(step?.error)
  }
  return step.result
}

/**
 * Runs a browser-element-functions action on the element the helper resolves. Returns false when
 * the element sits in a cross-origin frame, which page script cannot reach.
 */
async function actOnElement(
  session: ExternalChromiumBrowserSession,
  element: string,
  action: string,
  functionDeclaration: string,
  args: unknown[] = []
): Promise<{ reached: boolean; outcome?: unknown }> {
  const key = `__orcaElement${randomUUID().replaceAll('-', '')}`
  // No --bail: the last step must run to unwrap getAttribute even when the ref is stale.
  const [, read, call] = await session.runSteps([
    agentBrowserEvalCommand(captureScript(key)),
    ['get', 'attr', element, key],
    agentBrowserEvalCommand(callScript(key, functionDeclaration, args))
  ])
  stepResult(read)
  const { result } = ElementCallResult.parse(stepResult(call))
  if (!result.reached) {
    return { reached: false }
  }
  const { outcome } = result
  if (typeof outcome === 'string') {
    throw new BrowserError(
      'browser_element_not_interactable',
      `Cannot ${action} ${element}: ${outcome}`
    )
  }
  return { reached: true, outcome }
}

async function fill(
  session: ExternalChromiumBrowserSession,
  element: string,
  value: string,
  action: string
): Promise<void> {
  if ((await actOnElement(session, element, action, FILL_ELEMENT_FUNCTION, [value])).reached) {
    return
  }
  await session.run(['fill', element, value])
}

function selectAllShortcut(): string {
  return process.platform === 'darwin' ? 'Meta+a' : 'Control+a'
}

async function selectAll(session: ExternalChromiumBrowserSession, element: string): Promise<void> {
  const { reached, outcome } = await actOnElement(
    session,
    element,
    'select all in',
    SELECT_ALL_ELEMENT_FUNCTION
  )
  if (!reached) {
    await session.run(['focus', element])
  }
  // Code editors select their whole document from the shortcut, beyond the DOM they render;
  // an element that can't take focus keeps the DOM selection instead.
  if (!reached || outcome === true) {
    await session.run(['press', selectAllShortcut()])
  }
}

// The helper's `keyboard type` inserts text without key events, which key-driven editors ignore.
async function type(session: ExternalChromiumBrowserSession, input: string): Promise<void> {
  let commands: string[][] = []
  const flush = async (): Promise<void> => {
    if (commands.length === 0) {
      return
    }
    const steps = await session.runSteps(commands, { bail: true })
    commands = []
    if (steps.length === 0) {
      throw agentBrowserError(null)
    }
    steps.forEach(stepResult)
  }
  for (const step of typedInputSteps(input)) {
    // Text no US key types (emoji, accents) goes in like a paste.
    if (typeof step === 'string' || step.keyCode === 229) {
      commands.push(['keyboard', 'inserttext', typeof step === 'string' ? step : step.key])
    } else {
      // Shift is the only modifier a typed character carries; pages read it from the keydown.
      commands.push(['press', step.modifiers & 8 ? `Shift+${step.key}` : step.key])
    }
    if (commands.length >= MAX_KEY_COMMANDS_PER_RUN) {
      await flush()
    }
  }
  await flush()
}

/** Fill, clear, select, select-all and type, acting on the element the agent named; null for other methods. */
export async function runExternalChromiumPageInput(
  session: ExternalChromiumBrowserSession,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const element = String(params.element ?? '')
  switch (method) {
    case 'browserFill': {
      const value = String(params.value ?? '')
      await assertClipboardTextWriteWithinLimitWithYield(value)
      await fill(session, element, value, 'fill')
      return { filled: element }
    }
    case 'browserClear':
      await fill(session, element, '', 'clear')
      return { cleared: element }
    case 'browserSelect': {
      const value = String(params.value ?? '')
      // The helper reports success for any element; only a <select> has options to choose.
      await actOnElement(session, element, 'select an option in', SELECT_OPTION_TARGET_FUNCTION)
      await session.run(['select', element, value])
      return { selected: value }
    }
    case 'browserSelectAll':
      await selectAll(session, element)
      return { selected: element }
    case 'browserType': {
      const input = String(params.input ?? '')
      await assertClipboardTextWriteWithinLimitWithYield(input)
      await type(session, input)
      return { typed: true }
    }
    default:
      return null
  }
}
