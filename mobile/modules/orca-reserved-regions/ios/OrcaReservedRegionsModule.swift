import ExpoModulesCore
import UIKit

// Why: iPhone Duo reserves part of the window for its fold (when partially folded) and its
// camera, and neither shows up in the safe area. React Native has no view of either, so the
// window's active regions are reported here in window points, the root view's coordinates.
public class OrcaReservedRegionsModule: Module {
  private var probe: UIView?
  private var keyWindowObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("OrcaReservedRegions")

    Events("onChange")

    OnStartObserving {
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.installProbe()
        // A reconnected scene brings a new window; the probe follows it.
        self.keyWindowObserver = NotificationCenter.default.addObserver(
          forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main
        ) { [weak self] _ in
          self?.installProbe()
        }
      }
    }

    OnStopObserving {
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        if let keyWindowObserver = self.keyWindowObserver {
          NotificationCenter.default.removeObserver(keyWindowObserver)
        }
        self.keyWindowObserver = nil
        self.probe?.removeFromSuperview()
        self.probe = nil
      }
    }
  }

  private func installProbe() {
    guard let window = UIApplication.shared.delegate?.window ?? nil, probe?.window !== window else {
      return
    }
    probe?.removeFromSuperview()
    probe = nil
    #if canImport(UIKit, _version: 9127.0.85)
      // 9127.0.85 is UIKit in the iOS 27.1 SDK, the first with reserved regions; older Xcodes skip this.
      if #available(iOS 27.1, *) {
        let probe = ReservedRegionsProbe(frame: window.bounds)
        probe.onChange = { [weak self] payload in
          self?.sendEvent("onChange", payload)
        }
        window.insertSubview(probe, at: 0)
        self.probe = probe
      }
    #endif
  }
}

#if canImport(UIKit, _version: 9127.0.85)
  /// Invisible full-window view: it is laid out on every window resize and safe-area change, and
  /// its hinge interaction lays it out again when the device folds without changing size.
  @available(iOS 27.1, *)
  private final class ReservedRegionsProbe: UIView {
    var onChange: (([String: Any]) -> Void)?
    private var reported: ReservedRegionsSnapshot?
    private weak var keyboardView: UIView?
    private let keyboardFollower = KeyboardGeometryFollower()
    private var keyboardConstraints: [NSLayoutConstraint] = []

    override init(frame: CGRect) {
      super.init(frame: frame)
      autoresizingMask = [.flexibleWidth, .flexibleHeight]
      isUserInteractionEnabled = false
      isAccessibilityElement = false
      keyboardFollower.translatesAutoresizingMaskIntoConstraints = false
      keyboardFollower.onLayout = { [weak self] in self?.setNeedsLayout() }
      addSubview(keyboardFollower)
    }

    // A hinge interaction in the window crashes UIKit's split keyboard on an unfolded Duo when a web
    // view takes focus (iOS 27.2), so a fold that keeps the window size is caught by re-reading here.
    private var regionsTimer: Timer?

    override func willMove(toWindow newWindow: UIWindow?) {
      super.willMove(toWindow: newWindow)
      regionsTimer?.invalidate()
      regionsTimer = nil
      guard newWindow != nil else { return }
      regionsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
        guard let self, UIApplication.shared.applicationState == .active else { return }
        self.setNeedsLayout()
      }
    }

    required init?(coder: NSCoder) {
      fatalError("init(coder:) is not supported")
    }

    override func didMoveToWindow() {
      super.didMoveToWindow()
      NSLayoutConstraint.deactivate(keyboardConstraints)
      keyboardConstraints = []
      keyboardView = nil
      guard let window, let root = window.rootViewController?.view, root.window === window else {
        return
      }
      keyboardView = root
      let guide = root.keyboardLayoutGuide
      guide.usesBottomSafeArea = false
      keyboardConstraints = [
        keyboardFollower.topAnchor.constraint(equalTo: guide.topAnchor),
        keyboardFollower.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
        keyboardFollower.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
        keyboardFollower.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
      ]
      NSLayoutConstraint.activate(keyboardConstraints)
      setNeedsLayout()
    }

    override func safeAreaInsetsDidChange() {
      super.safeAreaInsetsDidChange()
      setNeedsLayout()
    }

    override func layoutSubviews() {
      super.layoutSubviews()
      guard let window else { return }
      let keyboardInset: CGFloat?
      if let keyboardView, keyboardView.window === window {
        let frame = keyboardView.convert(keyboardView.keyboardLayoutGuide.layoutFrame, to: window)
        let overlap = frame.intersection(window.bounds)
        keyboardInset = overlap.isNull ? 0 : overlap.height
      } else {
        keyboardInset = nil
      }
      let snapshot = ReservedRegionsSnapshot(
        divisions: window.reservedRegions(kind: .division).map(\.frame),
        hasFoldDivision: !window.reservedRegions(kind: .division, options: .includeInactive).isEmpty,
        occlusions: window.reservedRegions(kind: .occlusion).map(\.frame),
        windowBounds: window.bounds,
        windowSafeAreaInsets: window.safeAreaInsets,
        keyboardInset: keyboardInset
      )
      // The first layout always reports, so a listener starts from the real state.
      guard snapshot != reported else { return }
      reported = snapshot
      onChange?(snapshot.payload)
    }
  }

  @available(iOS 27.1, *)
  private final class KeyboardGeometryFollower: UIView {
    var onLayout: (() -> Void)?
    private var reportedFrame: CGRect?

    override func layoutSubviews() {
      super.layoutSubviews()
      guard frame != reportedFrame else { return }
      reportedFrame = frame
      onLayout?()
    }
  }

  private struct ReservedRegionsSnapshot: Equatable {
    let divisions: [CGRect]
    let hasFoldDivision: Bool
    let occlusions: [CGRect]
    let windowBounds: CGRect
    let windowSafeAreaInsets: UIEdgeInsets
    let keyboardInset: CGFloat?

    var payload: [String: Any] {
      var result: [String: Any] = [
        "divisions": divisions.map(Self.rectPayload),
        "hasFoldDivision": hasFoldDivision,
        "occlusions": occlusions.map(Self.rectPayload),
        "windowSafeArea": [
          "bounds": Self.rectPayload(windowBounds),
          "insets": [
            "top": Double(windowSafeAreaInsets.top),
            "right": Double(windowSafeAreaInsets.right),
            "bottom": Double(windowSafeAreaInsets.bottom),
            "left": Double(windowSafeAreaInsets.left),
          ],
        ],
      ]
      if let keyboardInset {
        result["keyboardInset"] = Double(keyboardInset)
      }
      return result
    }

    private static func rectPayload(_ rect: CGRect) -> [String: Double] {
      [
        "x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width),
        "height": Double(rect.height),
      ]
    }
  }
#endif
