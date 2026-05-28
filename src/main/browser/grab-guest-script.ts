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
    ancestorPathMaxEntries: 10,
    nearbyElementsMaxEntries: 6,
    nearbyElementMaxLength: 160,
    selectorMaxLength: 700,
    pathMaxLength: 900,
    cssClassesMaxLength: 500,
    selectedTextMaxLength: 500,
    sourceFileMaxLength: 500,
    reactComponentsMaxLength: 500
  };
  var TEXT_NODE_SCAN_LIMIT = 80;
  var NEARBY_ELEMENT_SCAN_LIMIT = 80;

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

  function normalizeText(text) {
    return String(text || '').trim().replace(/\\s+/g, ' ');
  }

  function getBoundedText(el, max) {
    try {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      var chunks = [];
      var length = 0;
      var inspected = 0;
      var node = walker.nextNode();
      while (node && length < max + 20 && inspected < TEXT_NODE_SCAN_LIMIT) {
        inspected++;
        var separatorLength = chunks.length > 0 ? 1 : 0;
        var remaining = max + 20 - length - separatorLength;
        if (remaining <= 0) break;
        var value = normalizeText((node.nodeValue || '').slice(0, remaining));
        if (value) {
          chunks.push(value.slice(0, remaining));
          length += Math.min(value.length, remaining) + separatorLength;
        }
        node = walker.nextNode();
      }
      return clampStr(normalizeText(chunks.join(' ')), max);
    } catch (e) {
      return '';
    }
  }

  function getTextSnippet(el) {
    return getBoundedText(el, BUDGET.textSnippetMaxLength);
  }

  function getSelectedText() {
    try {
      var selection = window.getSelection ? window.getSelection() : null;
      if (!selection || selection.rangeCount === 0) return '';
      var chunks = [];
      var length = 0;
      var inspected = 0;
      for (var i = 0; i < selection.rangeCount && length < BUDGET.selectedTextMaxLength + 20; i++) {
        var range = selection.getRangeAt(i);
        var walkerRoot = range.commonAncestorContainer;
        var walker = document.createTreeWalker(
          walkerRoot,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: function(node) {
              if (range.intersectsNode && !range.intersectsNode(node)) {
                return NodeFilter.FILTER_REJECT;
              }
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );
        var node = walkerRoot.nodeType === Node.TEXT_NODE ? walkerRoot : walker.nextNode();
        while (
          node &&
          length < BUDGET.selectedTextMaxLength + 20 &&
          inspected < TEXT_NODE_SCAN_LIMIT
        ) {
          inspected++;
          var textNode = node;
          var value = textNode.nodeValue || '';
          var separatorLength = chunks.length > 0 ? 1 : 0;
          var remaining = BUDGET.selectedTextMaxLength + 20 - length - separatorLength;
          if (remaining <= 0) break;
          if (value) {
            var start = textNode === range.startContainer ? range.startOffset : 0;
            var end = textNode === range.endContainer ? range.endOffset : value.length;
            if (end > start + remaining) {
              end = start + remaining;
            }
            if (textNode === range.startContainer) {
              start = Math.min(start, value.length);
            }
            value = value.slice(start, end);
            value = normalizeText(value);
          }
          if (value) {
            chunks.push(value.slice(0, remaining));
            length += Math.min(value.length, remaining) + separatorLength;
          }
          node = walker.nextNode();
        }
      }
      return clampStr(chunks.join(' '), BUDGET.selectedTextMaxLength);
    } catch (e) {
      return '';
    }
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
        if (ref) names.push(getBoundedText(ref, 100));
      }
      if (names.length) accessibleName = names.join(' ');
    } else {
      // Fall back to text content for buttons/links
      var tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'label') {
        accessibleName = getBoundedText(el, 100);
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

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function(ch) {
      return '\\\\' + ch;
    });
  }

  function looksHashy(value) {
    return /^[A-Za-z0-9_-]{12,}$/.test(value) && /\\d/.test(value) && /[A-Z]/.test(value);
  }

  function getStableClasses(el, maxCount) {
    if (!el.classList) return [];
    var result = [];
    for (var i = 0; i < el.classList.length && result.length < maxCount; i++) {
      var cls = el.classList[i];
      if (!cls || cls.length > 60 || containsSecret(cls)) continue;
      if (/^css-[a-z0-9]+$/i.test(cls) || looksHashy(cls)) continue;
      result.push(cls);
    }
    return result;
  }

  function buildSelectorPart(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id;
    if (id && !containsSecret(id)) {
      return tag + '#' + cssEscape(id);
    }
    var classes = getStableClasses(el, 2);
    if (classes.length > 0) {
      return tag + classes.map(function(cls) { return '.' + cssEscape(cls); }).join('');
    }
    return tag;
  }

  function isUniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch(e) {
      return false;
    }
  }

  function getNthOfTypeSuffix(current) {
    var tag = current.tagName;
    var index = 1;
    var sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === tag) index++;
      sibling = sibling.previousElementSibling;
    }
    if (index > 1) return ':nth-of-type(' + index + ')';

    sibling = current.nextElementSibling;
    while (sibling) {
      if (sibling.tagName === tag) return ':nth-of-type(1)';
      sibling = sibling.nextElementSibling;
    }
    return '';
  }

  function buildSelector(el) {
    var parts = [];
    var current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && parts.length < 10) {
      var part = buildSelectorPart(current);
      var parent = current.parentElement;
      if (parent && !isUniqueSelector(parts.concat([part]).reverse().join(' > '))) {
        part += getNthOfTypeSuffix(current);
      }
      parts.unshift(part);
      var selector = parts.join(' > ');
      if (isUniqueSelector(selector)) {
        return clampStr(selector, BUDGET.selectorMaxLength);
      }
      current = parent;
    }
    return clampStr(parts.join(' > ') || el.tagName.toLowerCase(), BUDGET.selectorMaxLength);
  }

  function buildReadablePath(el) {
    var parts = [];
    var current = el;
    while (current && current !== document.documentElement && parts.length < 6) {
      var tag = current.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') break;
      var label = tag;
      var aria = current.getAttribute('aria-label');
      var role = current.getAttribute('role');
      var stableClasses = getStableClasses(current, 1);
      if (current.id && !containsSecret(current.id)) {
        label = '#' + cssEscape(current.id);
      } else if (aria && !containsSecret(aria)) {
        label = tag + '[aria-label="' + clampStr(aria, 40).replace(/"/g, '\\\\"') + '"]';
      } else if (role && !containsSecret(role)) {
        label = tag + '[role="' + clampStr(role, 30).replace(/"/g, '\\\\"') + '"]';
      } else if (stableClasses.length > 0) {
        label = '.' + cssEscape(stableClasses[0]);
      }
      parts.unshift(label);
      current = current.parentElement;
    }
    return clampStr(parts.join(' > '), BUDGET.pathMaxLength);
  }

  function buildFullPath(el) {
    var parts = [];
    var current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement && parts.length < 20) {
      parts.unshift(buildSelectorPart(current));
      current = current.parentElement;
    }
    return clampStr(parts.join(' > '), BUDGET.pathMaxLength);
  }

  function getNearbyText(el) {
    var results = [];
    var parent = el.parentElement;
    if (!parent) return results;

    function addSiblingText(sibling) {
      if (!sibling) return;
      var text = getBoundedText(sibling, BUDGET.nearbyTextEntryMaxLength);
      if (text) {
        results.push(clampStr(text, BUDGET.nearbyTextEntryMaxLength));
      }
    }

    var inspected = 0;
    var previous = el.previousElementSibling;
    var next = el.nextElementSibling;
    while (
      results.length < BUDGET.nearbyTextMaxEntries &&
      inspected < NEARBY_ELEMENT_SCAN_LIMIT &&
      (previous || next)
    ) {
      if (previous) {
        var previousSibling = previous;
        previous = previous.previousElementSibling;
        inspected++;
        addSiblingText(previousSibling);
      }
      if (
        next &&
        results.length < BUDGET.nearbyTextMaxEntries &&
        inspected < NEARBY_ELEMENT_SCAN_LIMIT
      ) {
        var nextSibling = next;
        next = next.nextElementSibling;
        inspected++;
        addSiblingText(nextSibling);
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

  function getNearbyElements(el) {
    var parent = el.parentElement;
    if (!parent) return [];
    var result = [];

    function addSibling(sibling) {
      if (!sibling) return;
      if (sibling === el) return;
      var rect = sibling.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      var label = sibling.tagName.toLowerCase();
      var stableClasses = getStableClasses(sibling, 1);
      if (stableClasses.length > 0) label += '.' + stableClasses[0];
      var text = getBoundedText(sibling, 50);
      if (text) label += ' "' + clampStr(text, 50) + '"';
      result.push(clampStr(label, BUDGET.nearbyElementMaxLength));
    }
    var inspected = 0;
    var previous = el.previousElementSibling;
    var next = el.nextElementSibling;
    while (
      result.length < BUDGET.nearbyElementsMaxEntries &&
      inspected < NEARBY_ELEMENT_SCAN_LIMIT &&
      (previous || next)
    ) {
      if (previous) {
        var previousSibling = previous;
        previous = previous.previousElementSibling;
        inspected++;
        addSibling(previousSibling);
      }
      if (
        next &&
        result.length < BUDGET.nearbyElementsMaxEntries &&
        inspected < NEARBY_ELEMENT_SCAN_LIMIT
      ) {
        var nextSibling = next;
        next = next.nextElementSibling;
        inspected++;
        addSibling(nextSibling);
      }
    }
    return result;
  }

  function isElementFixed(el) {
    var current = el;
    while (current && current !== document.body) {
      var position = window.getComputedStyle(current).position;
      if (position === 'fixed' || position === 'sticky') return true;
      current = current.parentElement;
    }
    return false;
  }

  function getFiberFromElement(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
        try {
          return el[keys[i]] || null;
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }

  function getComponentNameFromFiber(fiber) {
    if (!fiber) return null;
    var type = fiber.type || fiber.elementType;
    if (!type || typeof type === 'string') return null;
    if (type.displayName || type.name) return type.displayName || type.name;
    if (type.render && (type.render.displayName || type.render.name)) {
      return type.render.displayName || type.render.name;
    }
    if (type.type && (type.type.displayName || type.type.name)) {
      return type.type.displayName || type.type.name;
    }
    return null;
  }

  function shouldSkipReactName(name) {
    if (!name || name.length <= 2) return true;
    return /^(Fragment|Root|Routes|Route|Outlet|Provider|Consumer|Profiler|Suspense)$/.test(name) ||
      /(?:Boundary|BoundaryHandler|Router|Provider|Consumer|Context|Wrapper)$/.test(name) ||
      /^(Inner|Outer|Client|Server|RSC|Dev|React|Hot)/.test(name);
  }

  function cleanSourcePath(path) {
    if (!path) return '';
    return String(path)
      .replace(/[?#].*$/, '')
      .replace(/^turbopack:\\/\\/\\/\\[project\\]\\//, '')
      .replace(/^webpack-internal:\\/\\/\\/\\.\\//, '')
      .replace(/^webpack-internal:\\/\\/\\//, '')
      .replace(/^webpack:\\/\\/\\/\\.\\//, '')
      .replace(/^webpack:\\/\\/\\//, '')
      .replace(/^turbopack:\\/\\/\\//, '')
      .replace(/^https?:\\/\\/[^/]+\\//, '')
      .replace(/^file:\\/\\/\\//, '/')
      .replace(/^\\([^)]+\\)\\/\\.\\//, '')
      .replace(/^\\.\\//, '');
  }

  function getReactMetadata(el) {
    try {
      var fiber = getFiberFromElement(el);
      var components = [];
      var sourceFile = null;
      var depth = 0;
      while (fiber && depth < 35) {
        var name = getComponentNameFromFiber(fiber);
        if (name && !shouldSkipReactName(name) && components.indexOf(name) === -1 && components.length < 6) {
          components.push(name);
        }
        var source = fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource);
        if (!sourceFile && source && source.fileName && source.lineNumber) {
          sourceFile = cleanSourcePath(source.fileName) + ':' + source.lineNumber +
            (source.columnNumber !== undefined ? ':' + source.columnNumber : '');
          if (containsSecret(sourceFile)) {
            sourceFile = null;
          }
        }
        fiber = fiber.return;
        depth++;
      }
      return {
        reactComponents: components.length > 0
          ? clampStr(components.slice().reverse().map(function(c) { return '<' + c + '>'; }).join(' '), BUDGET.reactComponentsMaxLength)
          : null,
        sourceFile: sourceFile ? clampStr(sourceFile, BUDGET.sourceFileMaxLength) : null
      };
    } catch (e) {
      return { reactComponents: null, sourceFile: null };
    }
  }

  // --- Build full payload for an element ---
  function extractPayload(el) {
    var rect = el.getBoundingClientRect();
    var react = getReactMetadata(el);
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
        elementPath: buildReadablePath(el),
        fullPath: buildFullPath(el),
        cssClasses: containsSecret(el.getAttribute('class') || '')
          ? '[redacted]'
          : clampStr(el.getAttribute('class') || '', BUDGET.cssClassesMaxLength),
        nearbyElements: getNearbyElements(el),
        selectedText: getSelectedText() || null,
        isFixed: isElementFixed(el),
        reactComponents: react.reactComponents,
        sourceFile: react.sourceFile,
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
    var text = getBoundedText(el, 40);
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

  function extractSelectedPayload(el) {
    try {
      return grab.extractPayload(el);
    } catch (error) {
      grab.cleanup();
      reject(error instanceof Error ? error : new Error('Failed to extract element context'));
      return null;
    }
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
    var payload = extractSelectedPayload(el);
    if (!payload) return;
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
    var payload = extractSelectedPayload(el);
    if (!payload) return;
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
  var payload = null;
  try {
    payload = grab.extractPayload(el);
  } catch (e) {
    grab.cleanup();
    return null;
  }
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
  try {
    return grab.extractPayload(el);
  } catch (e) {
    return null;
  }
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
