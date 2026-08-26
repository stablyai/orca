export const GRAB_GUEST_ELEMENT_CONTEXT_SCRIPT = `  function getComputedStyleSubset(el) {
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

`
