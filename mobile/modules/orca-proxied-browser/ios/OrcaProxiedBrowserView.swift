import ExpoModulesCore
import Network
import WebKit

/// A web view whose every connection goes through one host's loopback SOCKS5 proxy, or,
/// when direct, out on the phone's own network. A proxied view never loads before its proxy is set.
final class OrcaProxiedBrowserView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  let onNavigationState = EventDispatcher()

  private var proxyKey: String?
  private var storeId: String?
  private var requestedUrl: String?
  private var direct = false
  private var desktopSite = false
  private var loadedUrl: String?
  private var webView: WKWebView?
  private var observations: [NSKeyValueObservation] = []

  // Pages only: a file or custom-scheme URL from a host tab must not open the phone's own files or apps.
  private static let loadableSchemes: Set<String> = ["http", "https", "about"]

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
  }

  func setProxyKey(_ value: String) { proxyKey = value }
  func setStoreId(_ value: String) { storeId = value }
  func setUrl(_ value: String) { requestedUrl = value }
  // Read once, when the web view is created; switching networks remounts the view.
  func setDirect(_ value: Bool) { direct = value }
  // Read once too: a page asks for its layout when it loads, so switching remounts the view.
  func setDesktopSite(_ value: Bool) { desktopSite = value }

  func propsDidUpdate() {
    if webView == nil {
      createWebView()
    }
    guard let webView, let requestedUrl, requestedUrl != loadedUrl, let url = URL(string: requestedUrl),
      Self.loadableSchemes.contains(url.scheme?.lowercased() ?? "")
    else { return }
    loadedUrl = requestedUrl
    webView.load(URLRequest(url: url))
  }

  func goBack() { webView?.goBack() }
  func goForward() { webView?.goForward() }
  func reload() { webView?.reload() }
  func stopLoading() { webView?.stopLoading() }

  override func layoutSubviews() {
    super.layoutSubviews()
    webView?.frame = bounds
  }

  private func createWebView() {
    guard #available(iOS 17.0, *), let storeId, let identifier = UUID(uuidString: storeId),
      let proxies = proxyConfigurations()
    else { return }
    let store = WKWebsiteDataStore(forIdentifier: identifier)
    store.proxyConfigurations = proxies
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = store
    configuration.allowsInlineMediaPlayback = true
    configuration.defaultWebpagePreferences.preferredContentMode = desktopSite ? .desktop : .mobile
    let webView = WKWebView(frame: bounds, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    addSubview(webView)
    self.webView = webView
    observations = [
      webView.observe(\.url) { [weak self] _, _ in self?.publishState() },
      webView.observe(\.title) { [weak self] _, _ in self?.publishState() },
      webView.observe(\.isLoading) { [weak self] _, _ in self?.publishState() },
      webView.observe(\.canGoBack) { [weak self] _, _ in self?.publishState() },
      webView.observe(\.canGoForward) { [weak self] _, _ in self?.publishState() },
      webView.observe(\.estimatedProgress) { [weak self] _, _ in self?.publishState() }
    ]
  }

  @available(iOS 17.0, *)
  private func proxyConfigurations() -> [ProxyConfiguration]? {
    if direct {
      return []
    }
    guard let proxyKey, let server = OrcaProxiedBrowserModule.proxies[proxyKey], server.port != 0,
      let port = NWEndpoint.Port(rawValue: server.port)
    else { return nil }
    var proxy = ProxyConfiguration(
      socksv5Proxy: NWEndpoint.hostPort(host: .ipv4(.loopback), port: port))
    proxy.applyCredential(username: server.username, password: server.password)
    // Without failover a broken tunnel fails the load instead of going out on the phone's network.
    proxy.allowFailover = false
    return [proxy]
  }

  private func publishState(error: String? = nil) {
    guard let webView else { return }
    var payload: [String: Any] = [
      "url": webView.url?.absoluteString ?? "",
      "title": webView.title ?? "",
      "loading": webView.isLoading,
      "canGoBack": webView.canGoBack,
      "canGoForward": webView.canGoForward,
      "progress": webView.estimatedProgress
    ]
    if let error {
      payload["error"] = error
    }
    onNavigationState(payload)
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
  ) {
    publishState(error: error.localizedDescription)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    publishState(error: error.localizedDescription)
  }

  // Pages that open a new window load in this one, as the streamed browser does.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if navigationAction.targetFrame == nil {
      webView.load(navigationAction.request)
    }
    return nil
  }

  deinit {
    observations.removeAll()
  }
}
