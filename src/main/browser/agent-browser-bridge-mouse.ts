import type { WebContents } from 'electron'
import type { BrowserMouseModifier } from './agent-browser-bridge-types'

type CdpMouseButton = 'left' | 'middle' | 'right'

type BrowserClickPoint = {
  x: number
  y: number
  adjusted: boolean
  handled: boolean
}

export function normalizeCdpMouseButton(button?: string): CdpMouseButton {
  return button === 'middle' || button === 'right' ? button : 'left'
}

export function cdpMouseButtonMask(button: CdpMouseButton): number {
  if (button === 'right') {
    return 2
  }
  if (button === 'middle') {
    return 4
  }
  return 1
}

export function cdpMouseModifierMask(modifiers: BrowserMouseModifier[] | undefined): number {
  if (!modifiers || modifiers.length === 0) {
    return 0
  }
  let mask = 0
  for (const modifier of modifiers) {
    if (modifier === 'alt') {
      mask |= 1
    } else if (modifier === 'ctrl') {
      mask |= 2
    } else if (modifier === 'cmd') {
      mask |= 4
    } else if (modifier === 'shift') {
      mask |= 8
    }
  }
  return mask
}

export function readClickPoint(value: unknown, fallback: BrowserClickPoint): BrowserClickPoint {
  const point = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const x = point?.x
  const y = point?.y
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y)
  ) {
    return fallback
  }
  return { x, y, adjusted: point?.adjusted === true, handled: point?.handled === true }
}

export function mobileTouchClickExpression(
  x: number,
  y: number,
  radius: number,
  allowDomActivation: boolean
): string {
  return `(() => {
    const inputX = ${JSON.stringify(x)};
    const inputY = ${JSON.stringify(y)};
    const radius = ${JSON.stringify(radius)};
    const allowDomActivation = ${JSON.stringify(allowDomActivation)};
    const selector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      'summary',
      'label',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[onclick]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const isUsable = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
        style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    };
    const dispatchClick = (target, clickX, clickY) => {
      try {
        if (typeof target.focus === 'function') {
          target.focus({ preventScroll: true });
        }
      } catch {
        try { target.focus(); } catch {}
      }
      if (typeof target.click === 'function') {
        target.click();
        return true;
      }
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: clickX,
        clientY: clickY,
        screenX: clickX,
        screenY: clickY,
        button: 0,
        buttons: 1
      };
      try {
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'touch', pointerId: 1 }));
          target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'touch', pointerId: 1 }));
        }
      } catch {}
      target.dispatchEvent(new MouseEvent('mousedown', init));
      target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
      return true;
    };
    const clickableFor = (el) => {
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        if (node.matches(selector)) return node;
        if (window.getComputedStyle(node).cursor === 'pointer') return node;
      }
      return null;
    };
    const offsets = [[0, 0]];
    for (const distance of [radius * 0.45, radius, radius * 1.35]) {
      for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4, Math.PI,
        Math.PI * 5 / 4, Math.PI * 3 / 2, Math.PI * 7 / 4]) {
        offsets.push([Math.cos(angle) * distance, Math.sin(angle) * distance]);
      }
    }
    let best = null;
    for (const [dx, dy] of offsets) {
      const px = inputX + dx;
      const py = inputY + dy;
      if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) continue;
      for (const el of document.elementsFromPoint(px, py)) {
        const target = clickableFor(el);
        if (!target || !isUsable(target)) continue;
        const rect = target.getBoundingClientRect();
        const clickX = clamp(inputX, rect.left + 1, rect.right - 1);
        const clickY = clamp(inputY, rect.top + 1, rect.bottom - 1);
        const score = Math.hypot(clickX - inputX, clickY - inputY) + Math.hypot(dx, dy) * 0.25;
        if (!best || score < best.score) best = { score, x: clickX, y: clickY, target };
        break;
      }
    }
    if (best && allowDomActivation && dispatchClick(best.target, best.x, best.y)) {
      return { x: best.x, y: best.y, adjusted: true, handled: true };
    }
    if (best) {
      return { x: best.x, y: best.y, adjusted: true, handled: false };
    }
    return { x: inputX, y: inputY, adjusted: false, handled: false };
  })()`
}

export async function resolveMobileTouchClickPoint(
  dbg: WebContents['debugger'],
  x: number,
  y: number,
  radius: number | undefined,
  allowDomActivation: boolean
): Promise<BrowserClickPoint> {
  const fallback = { x, y, adjusted: false, handled: false }
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    return fallback
  }
  try {
    const result = await dbg.sendCommand('Runtime.evaluate', {
      expression: mobileTouchClickExpression(x, y, radius, allowDomActivation),
      returnByValue: true,
      silent: true
    })
    const raw = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
    const evaluated = raw?.result && typeof raw.result === 'object' ? raw.result : null
    return readClickPoint((evaluated as Record<string, unknown> | null)?.value, fallback)
  } catch {
    return fallback
  }
}
