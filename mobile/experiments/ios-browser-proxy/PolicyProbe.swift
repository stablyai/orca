import Foundation
import WebKit

extension ProxyProbe {
  func checkPolicies(port: UInt16, origin: String) async {
    let variants: [(String, [String], [String])] = [
      ("empty-suffix", [""], []),
      ("explicit-hosts", ["localhost", "127.0.0.1", "::1", "[::1]", "orca-proof.invalid"], []),
      ("exclude-localhost-control", [], ["localhost"])
    ]
    for (name, matches, excludes) in variants {
      let page = PageProbe(port: port, matches: matches, excludes: excludes)
      probes.append(page)
      for host in ["localhost", "127.0.0.1", "[::1]", "orca-proof.invalid"] {
        record("\(name)-load-\(host)", await page.load("http://\(host):\(origin)/?variant=\(name)"))
        record("\(name)-apis-\(host)", await page.inspect())
      }
    }
    let page = PageProbe(port: port)
    probes.append(page)
    let filters = ["^https?://127[.]0[.]0[.]1[:/]", "^wss?://127[.]0[.]0[.]1[:/]",
                   "^https?://\\[::1\\][:/]", "^wss?://\\[::1\\][:/]"]
    let rules: [[String: Any]] = filters.map { ["trigger": ["url-filter": $0], "action": ["type": "block"]] }
    do {
      let data = try JSONSerialization.data(withJSONObject: rules)
      let rule = try await WKContentRuleListStore.default().compileContentRuleList(
        forIdentifier: "orca.proxy-proof.literal-block", encodedContentRuleList: String(decoding: data, as: UTF8.self))
      if let rule { page.web.configuration.userContentController.add(rule) }
      else { record("content-blocker", "compile returned nil"); return }
    } catch { record("content-blocker", String(describing: error)); return }
    record("content-blocker-compiled", true)
    record("content-blocker-load", await page.load("http://localhost:\(origin)/?policy=1"))
    page.blockLiteralNavigation = true
    for host in ["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]"] {
      let script = """
        const host = '\(host):\(origin)';
        const fetchResult = await fetch('http://'+host+'/fetch?policy=1', {signal:AbortSignal.timeout(4000)}).then(r=>r.text()).catch(e=>'error:'+e.name);
        const websocket = await new Promise(resolve=>{ const w=new WebSocket('ws://'+host+'/hmr?policy=1'); const t=setTimeout(()=>{w.close();resolve('timeout')},4000); w.onmessage=e=>{clearTimeout(t);w.close();resolve(e.data)}; w.onerror=()=>{clearTimeout(t);resolve('error')}; });
        const image = await new Promise(resolve=>{ const i=new Image(); const t=setTimeout(()=>resolve('timeout'),4000); i.onload=()=>{clearTimeout(t);resolve('loaded')}; i.onerror=()=>{clearTimeout(t);resolve('error')}; i.src='http://'+host+'/image?policy=1'; document.body.append(i); });
        return {fetch:fetchResult, websocket, image};
        """
      record("content-blocker-subresources-\(host)", await page.script(script))
      record("native-policy-navigation-\(host)", await page.load("http://\(host):\(origin)/?policy=1"))
    }
  }
}
