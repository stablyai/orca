import UIKit
import WebKit
import Network

@main
final class ProxyProbe: UIResponder, UIApplicationDelegate {
  var probes: [PageProbe] = []
  var results: [[String: Any]] = []

  func applicationDidEnterBackground(_ application: UIApplication) { record("lifecycle-background", true) }
  func applicationWillEnterForeground(_ application: UIApplication) { record("lifecycle-foreground", true) }

  func application(_ app: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    guard ProcessInfo.processInfo.environment["ORCA_BACKGROUND_LAUNCH"] == "1" else { exit(2) }
    Task { await run() }
    return true
  }

  func record(_ name: String, _ value: Any) {
    results.append(["case": name, "value": value, "appState": UIApplication.shared.applicationState.rawValue])
    let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    if let data = try? JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]) {
      try? data.write(to: directory.appendingPathComponent("results.json"), options: .atomic)
    }
  }

  func run() async {
    let args = CommandLine.arguments
    guard args.count == 5, let a = UInt16(args[1]), let b = UInt16(args[2]) else { exit(3) }
    let origin = args[3]
    let control = args[4]
    guard let relayA = try? LoopbackRelay(upstreamPort: a), let relayB = try? LoopbackRelay(upstreamPort: b),
          let localA = try? await relayA.start(), let localB = try? await relayB.start() else {
      record("fatal", "native listener unavailable")
      return
    }
    let first = PageProbe(port: localA)
    let second = PageProbe(port: localB)
    probes = [first, second]
    for host in ["localhost", "127.0.0.1", "[::1]", "orca-proof.invalid"] {
      record("route-A-\(host)", await first.load("http://\(host):\(origin)/"))
      record("apis-A-\(host)", await first.inspect())
    }
    let identical = "http://localhost:\(origin)/"
    record("same-url-A", await first.load(identical))
    record("storage-A-set", await first.script("localStorage.setItem('route','A'); document.cookie='route=A; path=/'; return document.cookie"))
    record("same-url-B", await second.load(identical))
    record("storage-B-before", await second.script("return {local:localStorage.getItem('route'),cookie:document.cookie}"))
    record("storage-B-set", await second.script("localStorage.setItem('route','B'); document.cookie='route=B; path=/'; return document.cookie"))
    record("apis-B", await second.inspect())
    record("reload-A", await first.reload())
    record("storage-A-after", await first.script("return {local:localStorage.getItem('route'),cookie:document.cookie}"))
    record("apis-A-after-B", await first.inspect())
    await checkPolicies(port: localA, origin: origin)
    record("lifecycle-ready", true)
    try? await Task.sleep(nanoseconds: 12_000_000_000)
    record("apis-A-after-foreground", await first.inspect())
    record("reload-after-foreground", await first.reload())
    _ = try? await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(control)/tunnel-down")!)
    record("tunnel-down-fetch", await first.fetch())
    record("tunnel-down-websocket", await first.websocket())
    _ = try? await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(control)/listener-down")!)
    await relayA.stop()
    record("listener-down-fetch", await first.fetch())
    record("listener-down-websocket", await first.websocket())
    record("listener-down-navigation", await first.load(identical + "?loss=1"))
    for host in ["127.0.0.1", "[::1]"] {
      record("listener-down-navigation-\(host)", await first.load("http://\(host):\(origin)/?loss=1"))
      record("listener-down-apis-\(host)", await first.inspect())
    }
    record("route-B-survives", await second.inspect())
    await relayB.stop()
    record("complete", true)
  }
}

@MainActor
final class PageProbe: NSObject, WKNavigationDelegate {
  let web: WKWebView
  var completion: CheckedContinuation<String, Never>?
  var navigationID = 0
  var blockLiteralNavigation = false

  init(port: UInt16, matches: [String] = [], excludes: [String] = []) {
    let configuration = WKWebViewConfiguration()
    let store = WKWebsiteDataStore.nonPersistent()
    var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!))
    proxy.allowFailover = false
    proxy.excludedDomains = excludes
    proxy.matchDomains = matches
    store.proxyConfigurations = [proxy]
    configuration.websiteDataStore = store
    web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
    super.init()
    web.navigationDelegate = self
  }

  func settle(_ result: String) {
    completion?.resume(returning: result)
    completion = nil
  }

  func navigate(_ action: () -> Void) async -> String {
    await withCheckedContinuation { continuation in
      navigationID += 1
      let currentID = navigationID
      completion = continuation
      action()
      Task { [weak self] in
        try? await Task.sleep(nanoseconds: 12_000_000_000)
        if self?.navigationID == currentID && self?.completion != nil { self?.web.stopLoading(); self?.settle("timeout") }
      }
    }
  }

  func load(_ url: String) async -> String {
    await navigate { web.load(URLRequest(url: URL(string: url)!, cachePolicy: .reloadIgnoringLocalCacheData)) }
  }

  func reload() async -> String { await navigate { web.reload() } }

  func script(_ body: String) async -> Any {
    do { return try await web.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page) ?? NSNull() }
    catch { return ["error": error.localizedDescription] }
  }

  func fetch() async -> Any {
    await script("return await fetch('/fetch?nonce='+Math.random(), {cache:'no-store',signal:AbortSignal.timeout(4000)}).then(r=>r.text()).catch(e=>'error:'+e.name)")
  }

  func websocket() async -> Any {
    await script("return await new Promise(resolve=>{ const w=new WebSocket('ws://'+location.host+'/hmr'); const t=setTimeout(()=>{w.close();resolve('timeout')},4000); w.onmessage=e=>{clearTimeout(t);w.close();resolve(e.data)}; w.onerror=()=>{clearTimeout(t);resolve('error')}; })")
  }

  func inspect() async -> Any {
    let document = await script("return {url:location.href,body:document.body.textContent,local:localStorage.getItem('route'),cookie:document.cookie}")
    return ["document": document, "fetch": await fetch(), "websocket": await websocket()]
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { settle("loaded") }
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if blockLiteralNavigation, let host = navigationAction.request.url?.host,
       ["127.0.0.1", "::1", "[::1]"].contains(host) {
      settle("blocked-by-native-policy")
      decisionHandler(.cancel)
    } else { decisionHandler(.allow) }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { settle("error:\(error.localizedDescription)") }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { settle("error:\(error.localizedDescription)") }
}
