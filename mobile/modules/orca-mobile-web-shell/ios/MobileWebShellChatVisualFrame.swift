import Foundation

/// The one subframe document the shell serves: chat visuals run their scripts here, under this
/// response's policy instead of the page's. The page posts the built visual; it nests it in a
/// srcdoc child. Keep in sync with Kotlin and mobile-native-chat-visual-frame-contract.ts.
enum MobileWebShellChatVisualFrame {
  static let path = "/chat-visual-frame"

  /// NATIVE_CHAT_VISUAL_HOST_CSP without the CDN origins, so visuals load nothing remote (WebRTC is outside
  /// CSP, as on desktop), behind an opaque-origin sandbox that keeps the page's origin, storage and bridge out.
  static let csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline' data: blob:",
    "style-src 'unsafe-inline' data: blob:",
    "font-src data: blob:",
    "img-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri about:"
  ].joined(separator: "; ")

  static let document = Data("""
    <!doctype html>
    <html>
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:100%;background:transparent}</style>
    </head>
    <body>
    <script>
    (function () {
    'use strict'
    var host = window.parent
    var frame = null
    window.addEventListener('message', function (event) {
      if (event.source !== host) return
      if (frame) {
        if (frame.contentWindow) frame.contentWindow.postMessage(event.data, '*')
        return
      }
      var data = event.data
      if (!data || data.type !== 'orca-visual-document' || typeof data.html !== 'string') return
      frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'")
      if (typeof data.title === 'string') frame.setAttribute('title', data.title)
      frame.srcdoc = data.html
      document.body.appendChild(frame)
    })
    })()
    </script>
    </body>
    </html>
    """.utf8)
}
