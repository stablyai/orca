import { BROWSER_GRAB_SELECTED_ATTRIBUTE } from '../../../shared/browser/annotations/browser-annotation-viewport-bridge'

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

export const GRAB_GUEST_OVERLAY_SCRIPT = `  var host = document.createElement('div');
  host.id = '__orca-grab-host';
  host.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:all;cursor:crosshair;';
  document.documentElement.appendChild(host);

  // Picking leaves any text field: tool letters (A/G/D, C/S) then never type into the page while the picker is on.
  var focusedField = document.activeElement;
  if (
    focusedField &&
    (focusedField.isContentEditable ||
      focusedField.tagName === 'INPUT' ||
      focusedField.tagName === 'TEXTAREA' ||
      focusedField.tagName === 'SELECT') &&
    typeof focusedField.blur === 'function'
  ) {
    focusedField.blur();
  }

  var shadow = host.attachShadow({ mode: 'closed' });

  // The top layer paints the outline above modal dialogs, popovers and fullscreen elements.
  var overlay = document.createElement('div');
  overlay.popover = 'manual';
  overlay.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;';
  shadow.appendChild(overlay);

  // A light border and dark shadow keep the outline legible on arbitrary page backgrounds.
  var highlightBox = document.createElement('div');
  highlightBox.style.cssText = 'position:fixed;border:2px solid rgba(255,255,255,0.9);border-radius:3px;pointer-events:none;transition:all 0.05s ease-out;display:none;background:rgba(255,255,255,0.08);box-shadow:0 0 0 1px rgba(0,0,0,0.3),0 2px 8px rgba(0,0,0,0.15);';
  overlay.appendChild(highlightBox);

  var hoverLabel = document.createElement('div');
  hoverLabel.style.cssText = 'position:fixed;padding:3px 8px;background:rgba(30,30,30,0.92);color:#e5e5e5;font:11px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;border-radius:4px;pointer-events:none;white-space:nowrap;display:none;max-width:300px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
  overlay.appendChild(hoverLabel);

  var currentEl = null;
  // Where Orca's annotate palette covers the page, in the page frame's pixels (see setLabelAvoidArea).
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

  function updateHighlight(el) {
    if (!el || el === document.documentElement || el === document.body) {
      highlightBox.style.display = 'none';
      hoverLabel.style.display = 'none';
      currentEl = null;
      return;
    }
    currentEl = el;
    var rect = el.getBoundingClientRect();
    highlightBox.style.left = rect.x + 'px';
    highlightBox.style.top = rect.y + 'px';
    highlightBox.style.width = rect.width + 'px';
    highlightBox.style.height = rect.height + 'px';
    highlightBox.style.display = 'block';

    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role');
    var text = getBoundedText(el, 40);
    if (text.length > 40) text = text.slice(0, 37) + '...';
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    var parts = [tag];
    if (role) parts.push('role=' + role);
    if (text) parts.push('"' + text + '"');
    parts.push(w + 'x' + h);
    hoverLabel.textContent = parts.join('  ');
    // Shown before placing, so its width is measurable.
    hoverLabel.style.display = 'block';
    var place = placeLabel(rect);
    hoverLabel.style.left = place.left + 'px';
    hoverLabel.style.top = place.top + 'px';
  }

  function onPointerMove(e) {
    // Exclude the overlay from hit testing to find the page element underneath.
    host.style.pointerEvents = 'none';
    var el = document.elementFromPoint(e.clientX, e.clientY);
    // Document hit-testing stops at a shadow host; closed roots stay opaque.
    // Page code can shadow shadowRoot (e.g. a form control named "shadowRoot"); keep the deepest real hit.
    try {
      while (el && el.shadowRoot) {
        var inner = el.shadowRoot.elementFromPoint(e.clientX, e.clientY);
        if (!inner || inner === el) break;
        el = inner;
      }
    } catch (err) {
    } finally {
      host.style.pointerEvents = 'all';
    }
    if (el) {
      requestAnimationFrame(function() { updateHighlight(el); });
    }
  }

  // Later top-layer content stacks above the outline until it is shown again.
  function raiseOverlay(e) {
    if (e.type === 'toggle' && e.newState !== 'open') return;
    overlay.hidePopover();
    overlay.showPopover();
  }

  // Top-layer content covers the host and a modal dialog makes it inert, so the page gets that input directly.
  var PRESS_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'click', 'contextmenu'];
  function onPress(e) {
    // Page-scripted clicks and keyboard activation (click detail 0, contextmenu button -1) keep their default.
    if (!e.isTrusted || (e.type === 'click' && e.detail === 0) || (e.type === 'contextmenu' && e.button === -1)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if ((e.type === 'click' || e.type === 'contextmenu') && grab.onPick) grab.onPick(e);
  }

  function stopPointerInput() {
    window.removeEventListener('mousemove', onPointerMove, true);
    PRESS_EVENTS.forEach(function(type) { window.removeEventListener(type, onPress, true); });
  }

  overlay.showPopover();
  window.addEventListener('toggle', raiseOverlay, true);
  window.addEventListener('fullscreenchange', raiseOverlay, true);
  window.addEventListener('mousemove', onPointerMove, true);
  PRESS_EVENTS.forEach(function(type) { window.addEventListener(type, onPress, true); });

  var selectedAttribute = ${JSON.stringify(BROWSER_GRAB_SELECTED_ATTRIBUTE)};
  var selectedEl = null;
  var selectedValue = null;
  var previousSelectedValue = null;
  var frozenFrame = 0;
  var frozenResizeObserver = null;
  var frozenShadowRoots = [];

  function refreshFrozenHighlight() {
    frozenFrame = 0;
    if (selectedEl && selectedEl.isConnected) {
      updateHighlight(selectedEl);
    } else {
      highlightBox.style.display = 'none';
      hoverLabel.style.display = 'none';
    }
  }

  function scheduleFrozenHighlight() {
    if (!frozenFrame) frozenFrame = requestAnimationFrame(refreshFrozenHighlight);
  }

  function stopTrackingSelection() {
    window.removeEventListener('scroll', scheduleFrozenHighlight, true);
    frozenShadowRoots.forEach(function(root) {
      root.removeEventListener('scroll', scheduleFrozenHighlight, true);
    });
    frozenShadowRoots = [];
    window.removeEventListener('resize', scheduleFrozenHighlight, true);
    if (frozenResizeObserver) frozenResizeObserver.disconnect();
    frozenResizeObserver = null;
    if (frozenFrame) cancelAnimationFrame(frozenFrame);
    frozenFrame = 0;
    if (selectedEl && selectedEl.getAttribute(selectedAttribute) === selectedValue) {
      try {
        if (previousSelectedValue === null) selectedEl.removeAttribute(selectedAttribute);
        else selectedEl.setAttribute(selectedAttribute, previousSelectedValue);
      } catch(e) {}
    }
    selectedEl = null;
    selectedValue = null;
    previousSelectedValue = null;
  }

  var grab = window.__orcaGrab = {
    host: host,
    extractPayload: extractPayload,
    getCurrentElement: function() { return currentEl; },
    // Orca's palette moved, resized or closed: re-place the label for the hovered element.
    setLabelAvoidArea: function(area) {
      labelAvoidArea = area;
      if (currentEl && selectedEl === null) updateHighlight(currentEl);
    },
    // Release pointer events while preserving the selection outline for the copy menu.
    freezeHighlight: function(selectionId) {
      stopPointerInput();
      host.style.pointerEvents = 'none';
      host.style.cursor = 'default';
      // Capture scrolls so selection tracking includes nested scroll containers.
      selectedEl = currentEl;
      if (!selectedEl) return;
      // A DOM marker crosses isolated worlds without exposing the viewport bridge's token.
      previousSelectedValue = selectedEl.getAttribute(selectedAttribute);
      selectedValue = selectionId;
      selectedEl.setAttribute(selectedAttribute, selectionId);
      highlightBox.style.transition = 'none';
      window.addEventListener('scroll', scheduleFrozenHighlight, true);
      frozenShadowRoots = shadowRootsAbove(selectedEl);
      frozenShadowRoots.forEach(function(root) {
        root.addEventListener('scroll', scheduleFrozenHighlight, true);
      });
      window.addEventListener('resize', scheduleFrozenHighlight, true);
      if (typeof ResizeObserver === 'function') {
        frozenResizeObserver = new ResizeObserver(scheduleFrozenHighlight);
        frozenResizeObserver.observe(selectedEl, { box: 'border-box' });
        // A scrollbar appearing narrows the page without a window resize.
        if (selectedEl !== document.documentElement) {
          frozenResizeObserver.observe(document.documentElement);
        }
      }
    },
    // Set by awaitClick to receive the next pick.
    onPick: null,
    cleanup: function() {
      stopPointerInput();
      window.removeEventListener('toggle', raiseOverlay, true);
      window.removeEventListener('fullscreenchange', raiseOverlay, true);
      stopTrackingSelection();
      try { host.remove(); } catch(e) {}
      delete window.__orcaGrab;
    }
  };

  return true;
})()`
