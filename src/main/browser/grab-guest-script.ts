/* eslint-disable max-lines -- Why: the guest overlay runtime is a single
self-contained JS string template that must be injected atomically into the
guest page. Splitting it across modules would require a string concatenation
build step that adds complexity without improving auditability. */
// ---------------------------------------------------------------------------
// Browser Context Grab — guest overlay runtime builder
//
// This module produces self-contained JavaScript strings that main injects into
// browser guests via executeJavaScript(). The guest runtime is intentionally
// ephemeral: it installs on arm, resolves once on finalize, and fully removes
// itself on teardown.
//
// Why a string builder rather than a bundled file: Orca's browser guests have
// no preload and no Node access. The injected code must be a plain JS string
// that runs in the page's own world. Keeping it as a template here lets main
// version it alongside the rest of the grab lifecycle.
// ---------------------------------------------------------------------------

type GuestScriptAction = 'arm' | 'awaitClick' | 'finalize' | 'extractHover' | 'teardown'

/**
 * Build a self-contained JS script for the given grab lifecycle action.
 *
 * - `arm`: install the shadow-root overlay, hover listeners, and extraction logic
 * - `awaitClick`: return a Promise that resolves with the payload when the user clicks
 * - `finalize`: extract the payload for the currently hovered element and return it
 * - `extractHover`: extract the payload for the currently hovered element WITHOUT cleanup
 * - `teardown`: remove the overlay and all listeners
 */
export function buildGuestOverlayScript(action: GuestScriptAction): string {
  switch (action) {
    case 'arm':
      return ARM_SCRIPT
    case 'awaitClick':
      return AWAIT_CLICK_SCRIPT
    case 'finalize':
      return FINALIZE_SCRIPT
    case 'extractHover':
      return EXTRACT_HOVER_SCRIPT
    case 'teardown':
      return TEARDOWN_SCRIPT
  }
}

// ---------------------------------------------------------------------------
// The arm script installs the overlay container and hover tracking.
// It stores state on window.__orcaGrab so finalize/teardown can access it.
// ---------------------------------------------------------------------------
const ARM_SCRIPT = `(function() {
  'use strict';

  // Why: always tear down any pre-existing state before arming. A malicious
  // guest page could predefine window.__orcaGrab with a fake extractPayload
  // function. By tearing down unconditionally we ensure our freshly installed
  // extraction logic is the only code that runs.
  if (window.__orcaGrab) {
    try {
      if (typeof window.__orcaGrab.cleanup === 'function') {
        window.__orcaGrab.cleanup();
      }
    } catch(e) {}
    delete window.__orcaGrab;
  }

  // --- Budget constants (mirrored from shared types) ---
  var BUDGET = {
    textSnippetMaxLength: 200,
    nearbyTextEntryMaxLength: 200,
    nearbyTextMaxEntries: 10,
    htmlSnippetMaxLength: 4096,
    ancestorPathMaxEntries: 10
  };

  // --- Safe attribute names ---
  var SAFE_ATTRS = new Set([
    'id', 'class', 'name', 'type', 'role', 'href', 'src', 'alt',
    'title', 'placeholder', 'for', 'action', 'method'
  ]);

  var SECRET_PATTERNS = [
    'access_token', 'auth_token', 'api_key', 'apikey', 'client_secret',
    'oauth_state', 'x-amz-', 'session_id', 'sessionid', 'csrf',
    'secret', 'password', 'passwd'
  ];

  var STYLE_PROPS = [
    'display', 'position', 'width', 'height', 'margin', 'padding',
    'color', 'backgroundColor', 'border', 'borderRadius', 'fontFamily',
    'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'zIndex'
  ];

  // --- Helpers ---
  function clampStr(s, max) {
    if (!s || typeof s !== 'string') return '';
    if (s.length <= max) return s;
    return s.slice(0, max) + ' (truncated)';
  }

  function containsSecret(value) {
    if (!value) return false;
    var lower = value.toLowerCase();
    for (var i = 0; i < SECRET_PATTERNS.length; i++) {
      if (lower.indexOf(SECRET_PATTERNS[i]) !== -1) return true;
    }
    return false;
  }

  function sanitizeUrl(url) {
    try {
      var u = new URL(url);
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch (e) {
      // Why: returning the raw URL on parse failure could preserve javascript:
      // URIs or other non-http schemes. Return empty string instead.
      return '';
    }
  }

  function getTextSnippet(el) {
    var text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    return clampStr(text, BUDGET.textSnippetMaxLength);
  }

  function getHtmlSnippet(el) {
    var clone = el.cloneNode(true);
    // Strip script tags for safety
    var scripts = clone.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      scripts[i].remove();
    }
    var html = clone.outerHTML || '';
    return clampStr(html, BUDGET.htmlSnippetMaxLength);
  }

  function getSafeAttributes(el) {
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var attr = el.attributes[i];
      var name = attr.name.toLowerCase();
      var isAria = name.indexOf('aria-') === 0;
      if (!SAFE_ATTRS.has(name) && !isAria) continue;
      var value = attr.value;
      // Redact secret-looking values
      if (containsSecret(value)) {
        attrs[name] = '[redacted]';
      } else if ((name === 'href' || name === 'src' || name === 'action') && value) {
        // Strip query strings and fragments from URL-bearing attributes
        attrs[name] = sanitizeUrl(value);
      } else if (name === 'class') {
        // Cap class list length
        attrs[name] = clampStr(value, 200);
      } else {
        attrs[name] = value;
      }
    }
    return attrs;
  }

  function getAccessibility(el) {
    var role = el.getAttribute('role') || el.tagName.toLowerCase();
    var ariaLabel = el.getAttribute('aria-label') || null;
    var ariaLabelledBy = el.getAttribute('aria-labelledby') || null;
    var accessibleName = null;
    // Attempt to derive accessible name
    if (ariaLabel) {
      accessibleName = ariaLabel;
    } else if (ariaLabelledBy) {
      var parts = ariaLabelledBy.split(/\\s+/);
      var names = [];
      for (var i = 0; i < parts.length; i++) {
        var ref = document.getElementById(parts[i]);
        if (ref) names.push((ref.textContent || '').trim());
      }
      if (names.length) accessibleName = names.join(' ');
    } else {
      // Fall back to text content for buttons/links
      var tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'label') {
        accessibleName = clampStr((el.textContent || '').trim(), 100);
      } else if (el.getAttribute('title')) {
        accessibleName = el.getAttribute('title');
      } else if (el.getAttribute('alt')) {
        accessibleName = el.getAttribute('alt');
      }
    }
    return {
      role: role,
      accessibleName: accessibleName,
      ariaLabel: ariaLabel,
      ariaLabelledBy: ariaLabelledBy
    };
  }

  function getComputedStyleSubset(el) {
    var cs = window.getComputedStyle(el);
    var result = {};
    for (var i = 0; i < STYLE_PROPS.length; i++) {
      result[STYLE_PROPS[i]] = cs.getPropertyValue(
        STYLE_PROPS[i].replace(/[A-Z]/g, function(m) { return '-' + m.toLowerCase(); })
      ) || '';
    }
    return result;
  }

  function buildSelector(el) {
    var parts = [];
    var current = el;
    while (current && current !== document.body && parts.length < 10) {
      var tag = current.tagName.toLowerCase();
      var id = current.id;
      if (id) {
        parts.unshift(tag + '#' + CSS.escape(id));
        break;
      }
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(
          function(c) { return c.tagName === current.tagName; }
        );
        if (siblings.length > 1) {
          var index = siblings.indexOf(current) + 1;
          parts.unshift(tag + ':nth-of-type(' + index + ')');
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      current = parent;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function getNearbyText(el) {
    var results = [];
    var parent = el.parentElement;
    if (!parent) return results;
    var siblings = parent.children;
    for (var i = 0; i < siblings.length && results.length < BUDGET.nearbyTextMaxEntries; i++) {
      if (siblings[i] === el) continue;
      var text = (siblings[i].textContent || '').trim().replace(/\\s+/g, ' ');
      if (text) {
        results.push(clampStr(text, BUDGET.nearbyTextEntryMaxLength));
      }
    }
    return results;
  }

  function getAncestorPath(el) {
    var path = [];
    var current = el.parentElement;
    while (current && current !== document.documentElement && path.length < BUDGET.ancestorPathMaxEntries) {
      var tag = current.tagName.toLowerCase();
      var role = current.getAttribute('role');
      path.push(role ? tag + '[role=' + role + ']' : tag);
      current = current.parentElement;
    }
    return path;
  }

  // --- Build full payload for an element ---
  function extractPayload(el) {
    var rect = el.getBoundingClientRect();
    return {
      page: {
        sanitizedUrl: sanitizeUrl(window.location.href),
        title: document.title || '',
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio || 1,
        capturedAt: new Date().toISOString()
      },
      target: {
        tagName: el.tagName.toLowerCase(),
        selector: buildSelector(el),
        textSnippet: getTextSnippet(el),
        htmlSnippet: getHtmlSnippet(el),
        attributes: getSafeAttributes(el),
        accessibility: getAccessibility(el),
        rectViewport: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        },
        rectPage: {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height
        },
        computedStyles: getComputedStyleSubset(el)
      },
      nearbyText: getNearbyText(el),
      ancestorPath: getAncestorPath(el),
      screenshot: null
    };
  }

  // --- Overlay UI ---
  // Why: the host element is a full-viewport overlay with pointer-events:all
  // so it acts as a click catcher. This prevents the page from receiving the
  // selection click. The overlay uses elementFromPoint (with itself temporarily
  // hidden) to identify the element underneath the pointer.
  var host = document.createElement('div');
  host.id = '__orca-grab-host';
  host.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:all;cursor:crosshair;';
  document.documentElement.appendChild(host);

  var shadow = host.attachShadow({ mode: 'closed' });

  // Visual container for highlight/label — pointer-events:none so clicks go to host
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';
  shadow.appendChild(overlay);

  // Why: the highlight uses a white border with a dark outer shadow so it
  // reads well on both light and dark page backgrounds.
  var highlightBox = document.createElement('div');
  highlightBox.style.cssText = 'position:fixed;border:2px solid rgba(255,255,255,0.9);border-radius:3px;pointer-events:none;transition:all 0.05s ease-out;display:none;background:rgba(255,255,255,0.08);box-shadow:0 0 0 1px rgba(0,0,0,0.3),0 2px 8px rgba(0,0,0,0.15);';
  overlay.appendChild(highlightBox);

  // Hover label — dark neutral pill
  var hoverLabel = document.createElement('div');
  hoverLabel.style.cssText = 'position:fixed;padding:3px 8px;background:rgba(30,30,30,0.92);color:#e5e5e5;font:11px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;border-radius:4px;pointer-events:none;white-space:nowrap;display:none;max-width:300px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
  overlay.appendChild(hoverLabel);

  var currentEl = null;

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

    // Build label text
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role');
    var text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (text.length > 40) text = text.slice(0, 37) + '...';
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    var parts = [tag];
    if (role) parts.push('role=' + role);
    if (text) parts.push('"' + text + '"');
    parts.push(w + 'x' + h);
    hoverLabel.textContent = parts.join('  ');

    // Position label below the element, or above if near bottom
    var labelY = rect.bottom + 6;
    if (labelY + 28 > window.innerHeight) {
      labelY = rect.top - 28;
    }
    hoverLabel.style.left = Math.max(4, rect.x) + 'px';
    hoverLabel.style.top = labelY + 'px';
    hoverLabel.style.display = 'block';
  }

  function onPointerMove(e) {
    // Temporarily hide the overlay to hit-test the element underneath
    host.style.pointerEvents = 'none';
    var el = document.elementFromPoint(e.clientX, e.clientY);
    host.style.pointerEvents = 'all';
    if (el) {
      requestAnimationFrame(function() { updateHighlight(el); });
    }
  }

  // Why: mousemove on the host (not document) because the host is the
  // full-viewport click catcher that receives all pointer events.
  host.addEventListener('mousemove', onPointerMove);

  // Store state for awaitClick/finalize/teardown access
  window.__orcaGrab = {
    host: host,
    extractPayload: extractPayload,
    getCurrentElement: function() { return currentEl; },
    // Why: freeze the highlight so the selected element stays outlined while
    // the renderer shows the copy menu. Disabling pointer-events on the host
    // lets the cursor return to normal and prevents the crosshair from showing
    // over the dropdown menu's area in the webview.
    freezeHighlight: function() {
      host.removeEventListener('mousemove', onPointerMove);
      host.style.pointerEvents = 'none';
      host.style.cursor = 'default';
    },
    cleanup: function() {
      host.removeEventListener('mousemove', onPointerMove);
      try { host.remove(); } catch(e) {}
      delete window.__orcaGrab;
    }
  };

  return true;
})()`

// ---------------------------------------------------------------------------
// The awaitClick script returns a Promise that resolves when the user clicks
// on the full-viewport overlay. The click never reaches the page because the
// overlay host has pointer-events:all and the handler calls stopPropagation.
// ---------------------------------------------------------------------------
const AWAIT_CLICK_SCRIPT = `new Promise(function(resolve, reject) {
  'use strict';
  var grab = window.__orcaGrab;
  if (!grab) {
    reject(new Error('Grab not armed'));
    return;
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    grab.host.removeEventListener('click', onClick, true);
    grab.host.removeEventListener('contextmenu', onContext, true);
    var el = grab.getCurrentElement();
    if (!el) {
      grab.cleanup();
      reject(new Error('cancelled'));
      return;
    }
    var payload = grab.extractPayload(el);
    // Why: freeze the highlight instead of removing it so the user sees
    // which element was selected while the copy menu is shown. Teardown
    // happens later when the renderer calls setGrabMode(false) or re-arms.
    grab.freezeHighlight();
    resolve(payload);
  }

  function onContext(e) {
    // Why: right-click resolves with the payload wrapped in a context-menu
    // marker so the renderer can show the full action dropdown instead of
    // auto-copying. This gives users a deliberate path to screenshot and
    // other secondary actions while keeping left-click as the fast copy path.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    grab.host.removeEventListener('click', onClick, true);
    grab.host.removeEventListener('contextmenu', onContext, true);
    var el = grab.getCurrentElement();
    if (!el) {
      grab.cleanup();
      reject(new Error('cancelled'));
      return;
    }
    var payload = grab.extractPayload(el);
    grab.freezeHighlight();
    resolve({ __orcaContextMenu: true, payload: payload });
  }

  grab.host.addEventListener('click', onClick, true);
  grab.host.addEventListener('contextmenu', onContext, true);

  // Store cancel hook so teardown can reject the Promise
  grab.cancelAwait = function() {
    grab.host.removeEventListener('click', onClick, true);
    grab.host.removeEventListener('contextmenu', onContext, true);
    grab.cleanup();
    reject(new Error('cancelled'));
  };
})`

// ---------------------------------------------------------------------------
// The finalize script extracts the payload for the currently hovered element.
// ---------------------------------------------------------------------------
const FINALIZE_SCRIPT = `(function() {
  'use strict';
  var grab = window.__orcaGrab;
  if (!grab) return null;
  var el = grab.getCurrentElement();
  if (!el) return null;
  var payload = grab.extractPayload(el);
  grab.cleanup();
  return payload;
})()`

// ---------------------------------------------------------------------------
// The extractHover script reads the payload for the currently hovered element
// WITHOUT cleaning up. The overlay and awaitClick listener stay active so the
// user can continue picking elements. Used by keyboard shortcuts (C/S) that
// copy the hovered element without requiring a click first.
// ---------------------------------------------------------------------------
const EXTRACT_HOVER_SCRIPT = `(function() {
  'use strict';
  var grab = window.__orcaGrab;
  if (!grab) return null;
  var el = grab.getCurrentElement();
  if (!el) return null;
  return grab.extractPayload(el);
})()`

// ---------------------------------------------------------------------------
// The teardown script removes the overlay and cleans up all state.
// ---------------------------------------------------------------------------
const TEARDOWN_SCRIPT = `(function() {
  'use strict';
  var grab = window.__orcaGrab;
  if (!grab) return true;
  // If there's an active awaitClick Promise, cancel it so the
  // executeJavaScript call in main rejects and settles the grab op.
  if (grab.cancelAwait) {
    grab.cancelAwait();
  } else {
    grab.cleanup();
  }
  return true;
})()`
