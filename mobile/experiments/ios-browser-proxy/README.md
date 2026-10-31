# iOS hosted-browser proxy proof

This is an isolated feasibility experiment, not a production browser or protocol change.
On iOS 26.5, the tested `WKWebsiteDataStore.proxyConfigurations` configuration **does not provide desktop-parity routing**: literal loopback IP addresses bypass SOCKS, including after its listener is shut down. Do not infer a general fail-closed guarantee from the successful hostname cases.

## Reproduce

Requires macOS, Xcode, an installed iOS runtime with the iPhone 17 Pro device type, Python 3, Node, and the repository dependencies (including esbuild) installed. From the repository root:

```sh
ORCA_BACKGROUND_LAUNCH=1 python3 mobile/experiments/ios-browser-proxy/run.py /tmp/orca-ios-proxy-fresh-run
```

Use a fresh artifact directory. The runner compiles Swift directly against the simulator SDK, ad-hoc signs the app, creates its own simulator, boots it with `simctl` without launching Simulator.app, and never creates a UIWindow. It briefly launches Settings **inside the headless disposable simulator** to exercise background/foreground callbacks. It deletes only its own simulator and terminates its fixture process group in `finally`; it never erases or uses an existing device. An exit code of zero means the expected observations and cleanup passed, **not routing parity**: literal-IP and mapped-IPv6 bypasses are expected measurements. `observations.py` checks hostname routing, storage separation, callbacks, loss controls, rule compilation, and the policy network interval against both `results.json` and `network.jsonl`. It is a small regression check for this measured split, not a comprehensive security verifier; a changed platform result requires investigation, even if it improves routing.

The fixture uses the existing `RemoteBrowserSocksServer`; the installed esbuild bundles it for Node without downloading packages. No mobile dependencies or native project are changed. The compiled app, simulator metadata, raw native and network results, and cleanup receipt remain in the artifact directory. Delete that directory when no longer needed.

## What is measured

`WKWebView → in-app NWListener on 127.0.0.1 → transparent native TCP relay → existing Orca SOCKS parser → selected fixture HTTP server`.

Each of two nonpersistent website data stores has its own proxy configuration and listener. The baseline explicitly sets `allowFailover = false`, `excludedDomains = []`, and `matchDomains = []`. A and B map the same requested host/port to different HTTP servers. A separate dual-stack direct server listens on the requested origin port and labels every response `DIRECT-BYPASS`. Thus receiving a page does not by itself count as successful proxying.

The fixture maps the reserved `.invalid` hostname without resolving it. Seeing the original hostname in the SOCKS server's `open` callback proves hostname transport to the proxy; it does not measure upstream DNS or rule out speculative local DNS. HTTP documents, same-origin fetch, and a WebSocket text frame are checked independently. The WebSocket exchange is a small HMR transport smoke test, not a Vite application or a persistent HMR connection test.

Tunnel loss is simulated by destroying route A's active upstream sockets and rejecting subsequent SOCKS opens. Listener loss additionally closes the native listener and its accepted connections. This does not exercise Orca's actual encrypted browser tunnel, relay, or SSH route.

## Observed results — 2026-09-25

Xcode 27.0 (27A266a), arm64 simulator, iOS 26.5 (23F77). Evidence is preserved in [evidence.jsonl](./evidence.jsonl). The corrected run's full local artifacts are `/tmp/orca-ios-proxy-corrected`; the original run remains at `/tmp/orca-ios-proxy-proof-reviewed`.

| Case                                            | Observation                                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localhost` document, fetch, WebSocket          | All use SOCKS route A; hostname reaches SOCKS unchanged.                                                                                                       |
| `127.0.0.1` document, fetch, WebSocket          | All hit `DIRECT-BYPASS`; no corresponding SOCKS open.                                                                                                          |
| `[::1]` document, fetch, WebSocket              | All hit `DIRECT-BYPASS`; no corresponding SOCKS open.                                                                                                          |
| `orca-proof.invalid` document, fetch, WebSocket | All use A; unresolved hostname reaches SOCKS unchanged.                                                                                                        |
| Identical localhost URL in stores A and B       | A returns A, B returns B; opening B does not change A.                                                                                                         |
| Cookie and localStorage isolation               | B initially sees neither A's cookie nor localStorage value; both retain their own values.                                                                      |
| Reload                                          | A reloads through A and retains its own storage.                                                                                                               |
| Short background/foreground cycle               | Actual application callbacks recorded; A's document, storage, fresh fetch and fresh WebSocket work after return, then reload succeeds.                         |
| Simulated tunnel loss, localhost                | Fetch and WebSocket fail; no direct fallback.                                                                                                                  |
| Native listener loss, localhost                 | Fetch, WebSocket and navigation fail; no direct fallback.                                                                                                      |
| Listener loss, literal loopback IPs             | Direct access is still possible; see final native results.                                                                                                     |
| Limited native policy, `[::ffff:127.0.0.1]`     | Fetch, WebSocket, image network request and navigation reach the direct trap as canonical `[::ffff:7f00:1]`; image reports error because the response is HTML. |
| Independent route during A failure              | B's document, fetch, WebSocket and storage remain usable.                                                                                                      |

The in-app listener and offscreen WebView worked without adding a Local Network usage description in this simulator. This is **not** evidence that real devices need no Local Network permission. An earlier run with WKWebView pointed directly at the Mac's SOCKS fixture showed the same IP bypass, independently of the native relay.

## Limits and recommendation

Unmeasured: real iPhones; iOS 17–26.4; HTTPS/WSS and certificate handling; IPs beyond the three literals above; redirects and third-party subresources; persistent stores, IndexedDB, caches and service workers; WebRTC/UDP/QUIC/WebTransport; WebAuthn related-origin requests; DNS prefetch and DNS packet capture; actual Vite HMR; long-lived WebSockets across suspension; device locking, long background suspension, memory pressure, process termination and relaunch; real tunnel/relay/SSH failure and reconnect; automation parity beyond native JavaScript evaluation. The short lifecycle test establishes recovery after an app switch, not reliable background hosting. No platform-wide no-bypass guarantee is established. The tested nondefault match settings are listed below; other configurations and proxy types remain untested.

The domain-policy rerun kept failover disabled. `matchDomains = [""]` and explicit entries for `localhost`, `127.0.0.1`, `::1`, `[::1]`, and `orca-proof.invalid` preserved exactly the same routing split. An `excludedDomains = ["localhost"]` control correctly made localhost go direct while `.invalid` still used SOCKS, demonstrating that the configuration was applied. The empty-string candidate is an experiment, not a documented universal-match guarantee.

The installed Network `proxy_config.h` describes match/excluded entries as hostname suffixes and exposes no explicit implicit-loopback override. WebKit's [NetworkSessionCocoa implementation](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/NetworkProcess/cocoa/NetworkSessionCocoa.mm), inspected on 2026-09-25, forwards proxy configurations into Network contexts or NSURLSession. This bounded source/API review found no public equivalent of Chromium's loopback-bypass removal; it does not prove no solution exists elsewhere in the platform.

A separate native-policy probe installs four simple WKContentRuleList expressions before loading the localhost document. It blocks fetch, WebSocket and image requests to the two tested literal loopbacks; the network log must show no direct requests to those two addresses between the `/?policy=1` document and the first loss-control event. The same interval deliberately exercises mapped IPv6 and records four direct events for that host; error callbacks alone cannot prove blocking. WKNavigationDelegate separately rejects navigation to those literal hosts. The fence is deliberately limited to those exact addresses: it is **not** a complete 127/8, alternate-IP-spelling, redirected-resource, worker or UDP policy. No JavaScript API monkey patch is involved. A combined regex with alternation was rejected by the content-rule compiler; separate simple rules compiled successfully.

The independent adversarial review also observed mapped-IPv6 bypass through redirects, frames and a blob worker (seven direct events in its expanded run at `/tmp/orca-ios-proxy-adversarial-variants`). This committed regression retains the four mechanisms already in the small harness, without extending the blacklist. The current policy is only a limited demonstration and does not establish even a hostname-only safety boundary. A default-deny native policy with an explicit small hostname allow-list would be a candidate for a separately validated pilot, subject to all-resource and real-device validation. It must explicitly refuse unsupported requests rather than silently send them from the phone. That limited product contract differs from desktop parity; this experiment does not authorize shipping it.

The smallest recommended production change for unrestricted desktop parity is **none yet**. Keep existing server-hosted browsing available while resolving the native routing gap. Rewriting only top-level loopback URLs would miss fetches, WebSockets, redirects and embedded resources and would change origin/storage semantics; it is not a parity fix.

If the routing gate can be satisfied, the smallest candidate is a native iOS browser view with one store/listener per execution route, installed before navigation, reusing the existing SOCKS/tunnel contract and native JavaScript evaluation. Keep it separate from `OrcaMobileWebShellView`, whose private-origin shell deliberately blocks HTTP and WebSocket networking. The existing shell has an iOS 15.1 floor, whereas Apple's proxy API is iOS 17+; preserve an availability-gated fallback. No host admission or browser protocol changes belong in this experiment.

The original requested design path was absent from commit `8fa5883217e9479b8155d49edc7548b854adb4fb`; the coordinator supplied the proposal through orchestration message `msg_f76d0f810c83`. Its conditional iOS recommendation is weakened by the measured literal-IP bypass.

Apple references: [ProxyConfiguration](https://developer.apple.com/documentation/network/proxyconfiguration) documents SOCKSv5 and failover behavior; [WKWebsiteDataStore proxyConfigurations](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/proxyconfigurations-cdc1) exposes per-store configuration. The installed SDK declares this API available from iOS 17. Neither API availability nor disabled failover proves every destination is proxied.

## Validation and cleanup

The corrected headless run recorded 65 native records and 97 network events in [evidence.jsonl](./evidence.jsonl). All 13 executable tests passed. Run them without a simulator or network service:

```sh
ORCA_BACKGROUND_LAUNCH=1 python3 -m unittest discover -s mobile/experiments/ios-browser-proxy -v
```

The tests inject shutdown failure while preserving the original launch exception and prove delete, fixture termination, reap and receipt writing still happen. A second failure case covers delete failure, SIGTERM failure, bounded wait expiry, SIGKILL escalation and reap failure. Measurement tests require actual boolean completion, compilation and lifecycle observations, and reject broken hostname routing or missing callbacks. Network checks require HTTP/WebSocket event types for each mapped-IPv6 mechanism, route B traffic before loss, a rejected SOCKS attempt between loss controls, both literal-loopback navigation/fetch/WebSocket sequences after listener loss, and fresh B fetch/WebSocket traffic afterward. Negative tests remove or corrupt those witnesses, including truncating the capture at listener loss and removing every B event; retained evidence still passes with its expected bypasses. These witnesses support the bounded capture, not a platform-wide no-fallback guarantee.

Cleanup attempts shutdown and delete independently with timeouts, then terminates the owned process group even if its launcher has already exited. Bounded waits escalate to SIGKILL and reap the launcher; group absence is checked separately from launcher exit. `cleanup.json` records actual outcomes and every cleanup error plus the original run error. Any cleanup error makes an otherwise successful run fail; when the run already failed, its original exception is retained and cleanup evidence is also printed to stderr. Receipt-write failures are reported to stderr. No unrelated simulator or process is targeted.

The corrected run deleted its owned simulator and exited its fixture group. No existing simulator/device was erased, no Simulator.app window was opened, and no Android emulator was launched. Temporary build and evidence artifacts remain available for review. Installed oxlint/oxfmt checks and Python compilation passed; full app typechecking was not needed for this isolated experiment. No production code or PR was created; independent follow-up review remains required.
