import type { BrowserGrabLabelAvoidArea } from '../../../shared/browser/element-grab/browser-grab-types'

/** Tells an armed picker where Orca's annotate palette (and its hint) cover the page; null when nothing does. */
export function buildGrabLabelAvoidScript(area: BrowserGrabLabelAvoidArea | null): string {
  // Only validated numbers reach here (see parseGrabLabelAvoidArea); JSON keeps them inert.
  return `(function() {
  var grab = window.__orcaGrab;
  if (grab && typeof grab.setLabelAvoidArea === 'function') grab.setLabelAvoidArea(${JSON.stringify(area)});
  return true;
})()`
}

/** Hover-label placement that keeps clear of Orca's palette; pasted into the overlay script's scope. */
export const GRAB_GUEST_LABEL_PLACEMENT_SCRIPT = `  // Where Orca's annotate palette covers the page, in the page frame's pixels (see setLabelAvoidArea).
  var labelAvoidArea = null;
  var LABEL_SPACE = 28;

  function labelAvoidRect() {
    var area = labelAvoidArea;
    if (!area) return null;
    // Orca measures in its own pixels; the page's differ by its zoom (and any device emulation scale).
    var sx = window.innerWidth / area.frameWidth;
    var sy = window.innerHeight / area.frameHeight;
    return {
      left: area.x * sx - 4,
      top: area.y * sy - 4,
      right: (area.x + area.width) * sx + 4,
      bottom: (area.y + area.height) * sy + 4
    };
  }

  function labelFits(left, top, width, avoid) {
    if (top < 0 || top + LABEL_SPACE > window.innerHeight) return false;
    return !avoid || left >= avoid.right || left + width <= avoid.left || top >= avoid.bottom || top + LABEL_SPACE <= avoid.top;
  }

  // Below the element, else above it, else beside the palette, else just under it: never under the palette.
  function placeLabel(rect) {
    var width = hoverLabel.offsetWidth || 160;
    var left = Math.max(4, rect.x);
    var below = rect.bottom + 6;
    var above = rect.top - LABEL_SPACE;
    var avoid = labelAvoidRect();
    var tops = [below, above];
    for (var i = 0; i < tops.length; i++) {
      if (labelFits(left, tops[i], width, avoid)) return { left: left, top: tops[i] };
    }
    var fallbackTop = below + LABEL_SPACE > window.innerHeight ? above : below;
    fallbackTop = Math.min(Math.max(0, fallbackTop), window.innerHeight - LABEL_SPACE);
    if (avoid) {
      var besideLefts = [avoid.right, avoid.left - width];
      for (var j = 0; j < besideLefts.length; j++) {
        var besideLeft = besideLefts[j];
        if (besideLeft >= 4 && besideLeft + width <= window.innerWidth - 4 && labelFits(besideLeft, fallbackTop, width, avoid)) {
          return { left: besideLeft, top: fallbackTop };
        }
      }
      var under = Math.min(avoid.bottom, window.innerHeight - LABEL_SPACE);
      if (labelFits(left, under, width, avoid)) return { left: left, top: under };
    }
    return { left: left, top: fallbackTop };
  }
`

/** Tracks whether a page field has focus for the whole pick; pasted into the overlay script's scope. */
export const GRAB_GUEST_EDITABLE_FOCUS_SCRIPT = `  // Whether keys typed now belong to a page field, for the whole pick (focus can move by Tab or page script, into
  // shadow roots or frames). Orca reads this before taking a bare tool letter, so a field keeps its typing.
  var NON_TEXT_INPUTS = ['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'color', 'range', 'hidden'];
  function deepActiveElement() {
    var el = document.activeElement;
    try {
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    } catch (err) {}
    return el;
  }
  function takesTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    // A focused frame's own field can't be seen from here; let the frame keep its keys.
    if (tag === 'IFRAME' || tag === 'FRAME' || tag === 'OBJECT' || tag === 'EMBED') return true;
    if (el.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return NON_TEXT_INPUTS.indexOf(String(el.type || 'text').toLowerCase()) === -1;
    return false;
  }
  var editableFocused = takesTyping(deepActiveElement());
  var editableWaiters = [];
  function publishEditable() {
    var next = takesTyping(deepActiveElement());
    if (next === editableFocused) return;
    editableFocused = next;
    var waiters = editableWaiters;
    editableWaiters = [];
    waiters.forEach(function(resolve) { resolve(next); });
  }
  // On focusout the next element isn't focused yet; read once focus has settled.
  function publishEditableSoon() { setTimeout(publishEditable, 0); }
  window.addEventListener('focusin', publishEditable, true);
  window.addEventListener('focusout', publishEditableSoon, true);
`
