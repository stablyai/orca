import { Buffer } from 'buffer/'

export const MOBILE_HTML_PREVIEW_MESSAGE_CHANNEL = 'orca-mobile-html-preview'
export const MOBILE_HTML_PREVIEW_SCRIPT_CSP_HASH =
  "'sha256-kwh1h6IbgYr08HhgH2Y5HskcfOg80ZUbQJgPpSamqOE='"

export const MOBILE_HTML_PREVIEW_SCRIPT = String.raw`(function () {
  var allowedTags = new Set(
    'a abbr address article aside b blockquote br caption cite code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark meter nav ol p pre progress q s section small span strong style sub summary sup table tbody td tfoot th thead tr u ul'
      .split(' ')
  );
  var dropContentTags = new Set(
    'audio base button canvas embed form iframe input link math meta noscript object option script select source svg template textarea track video'
      .split(' ')
  );
  var remainingNodes = 20000;

  function safeExternalUrl(value, httpsOnly) {
    var trimmed = String(value || '').trim();
    if (trimmed.length === 0 || trimmed.length > 4096) return null;
    try {
      var parsed = new URL(trimmed);
      if (parsed.protocol === 'https:') return trimmed;
      return httpsOnly !== true && parsed.protocol === 'http:' ? trimmed : null;
    } catch (_) {
      return null;
    }
  }

  function safeRasterDataUrl(value) {
    var trimmed = String(value || '').trim();
    return trimmed.length <= 262144 &&
      /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon);base64,[a-z0-9+/=]+$/i.test(trimmed)
      ? trimmed
      : null;
  }

  function safeCss(value) {
    return !/(?:url\s*\(|@import|expression\s*\(|behavior\s*:|-moz-binding)/i.test(value);
  }

  function sanitizedChildren(node, depth) {
    var fragment = document.createDocumentFragment();
    Array.prototype.forEach.call(node.childNodes || [], function (child) {
      fragment.appendChild(sanitizeNode(child, depth + 1));
    });
    return fragment;
  }

  function copyAttribute(source, target, tag, attribute) {
    var name = attribute.name.toLowerCase();
    var value = attribute.value;
    if (name.indexOf('on') === 0 || name === 'srcdoc') return;
    if (name === 'href' && tag === 'a') {
      var href = safeExternalUrl(value);
      if (href) target.setAttribute('href', href);
      return;
    }
    if (name === 'src' && tag === 'img') {
      var src = safeRasterDataUrl(value) || safeExternalUrl(value, true);
      if (src) target.setAttribute('src', src);
      return;
    }
    if (name === 'style') {
      if (safeCss(value)) target.setAttribute('style', value);
      return;
    }
    if (
      name === 'class' ||
      name === 'dir' ||
      name === 'id' ||
      name === 'lang' ||
      name === 'title' ||
      name.indexOf('aria-') === 0 ||
      name.indexOf('data-') === 0
    ) {
      target.setAttribute(name, value);
      return;
    }
    if (
      (tag === 'img' && (name === 'alt' || name === 'height' || name === 'width')) ||
      (tag === 'td' && (name === 'colspan' || name === 'rowspan')) ||
      (tag === 'th' && (name === 'colspan' || name === 'rowspan' || name === 'scope')) ||
      (tag === 'ol' && (name === 'reversed' || name === 'start' || name === 'type')) ||
      (tag === 'li' && name === 'value') ||
      (tag === 'details' && name === 'open') ||
      ((tag === 'meter' || tag === 'progress') &&
        (name === 'high' || name === 'low' || name === 'max' || name === 'min' || name === 'optimum' || name === 'value'))
    ) {
      target.setAttribute(name, value);
    }
  }

  function sanitizeNode(node, depth) {
    var empty = document.createDocumentFragment();
    if (remainingNodes <= 0 || depth > 64) return empty;
    remainingNodes -= 1;
    if (node.nodeType === 3) return document.createTextNode(node.nodeValue || '');
    if (node.nodeType !== 1) return empty;
    var tag = String(node.localName || '').toLowerCase();
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || dropContentTags.has(tag)) {
      return empty;
    }
    if (!allowedTags.has(tag)) return sanitizedChildren(node, depth);
    if (tag === 'style') {
      if (!safeCss(node.textContent || '')) return empty;
      var style = document.createElement('style');
      style.textContent = node.textContent || '';
      return style;
    }
    var clone = document.createElement(tag);
    Array.prototype.forEach.call(node.attributes || [], function (attribute) {
      copyAttribute(node, clone, tag, attribute);
    });
    clone.appendChild(sanitizedChildren(node, depth));
    return clone;
  }

  function decodeSource() {
    var encoded = document.getElementById('source').value;
    var binary = atob(encoded);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  var preview = document.getElementById('preview');
  var parsed = new DOMParser().parseFromString(decodeSource(), 'text/html');
  Array.prototype.forEach.call(parsed.head.querySelectorAll('style'), function (style) {
    preview.appendChild(sanitizeNode(style, 0));
  });
  preview.appendChild(sanitizedChildren(parsed.body, 0));
  preview.addEventListener('click', function (event) {
    var link = event.target && event.target.closest && event.target.closest('a[href]');
    if (!link || !preview.contains(link)) return;
    event.preventDefault();
    var url = safeExternalUrl(link.getAttribute('href'));
    if (!url) return;
    var message = JSON.stringify({
      channel: '${MOBILE_HTML_PREVIEW_MESSAGE_CHANNEL}',
      type: 'openExternal',
      token: window.name || '',
      url: url
    });
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(message);
    else if (window.parent !== window) window.parent.postMessage(message, '*');
  });
})();`

const MOBILE_HTML_PREVIEW_CSP = [
  "default-src 'none'",
  `script-src ${MOBILE_HTML_PREVIEW_SCRIPT_CSP_HASH}`,
  "style-src 'unsafe-inline'",
  // Why: `https:` keeps the remote images main rendered; plaintext `http:` stays blocked.
  'img-src data: https:',
  "font-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

export function buildMobileHtmlPreviewDocument(html: string): string {
  const encoded = Buffer.from(html, 'utf8').toString('base64')
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <meta http-equiv="Content-Security-Policy" content="${MOBILE_HTML_PREVIEW_CSP}" />
  <style>html,body,#preview{box-sizing:border-box;min-height:100%;margin:0}body{background:#fff;color:#000}#preview{padding:8px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>
</head>
<body>
  <textarea id="source" hidden>${encoded}</textarea>
  <main id="preview"></main>
  <script>${MOBILE_HTML_PREVIEW_SCRIPT}</script>
</body>
</html>`
}

export function parseMobileHtmlPreviewMessage(value: unknown, expectedToken = ''): string | null {
  try {
    const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const message = parsed as Record<string, unknown>
    if (
      message.channel !== MOBILE_HTML_PREVIEW_MESSAGE_CHANNEL ||
      message.type !== 'openExternal' ||
      message.token !== expectedToken ||
      typeof message.url !== 'string'
    ) {
      return null
    }
    const url = message.url.trim()
    if (url.length === 0 || url.length > 4096) {
      return null
    }
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' ? url : null
  } catch {
    return null
  }
}
