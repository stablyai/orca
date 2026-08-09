import Testing
@testable import OrcaComputerUseMacOSCore

@Suite("Screen capture probe window selection")
struct ScreenCaptureProbeWindowSelectionTests {
    @Test("own process windows cannot prove cross-app capture permission")
    func excludesOwnWindows() {
        let selected = ScreenCaptureProbeWindowSelection.firstCrossProcessNormalWindow(
            ownPid: 42,
            windows: [
                .init(layer: 0, ownerPid: 42, windowId: 1),
                .init(layer: 0, ownerPid: 84, windowId: 2)
            ]
        )

        #expect(selected == 2)
    }

    @Test("non-normal windows are skipped")
    func excludesNonNormalWindows() {
        let selected = ScreenCaptureProbeWindowSelection.firstCrossProcessNormalWindow(
            ownPid: 42,
            windows: [
                .init(layer: 1, ownerPid: 84, windowId: 1),
                .init(layer: 0, ownerPid: 84, windowId: 2)
            ]
        )

        #expect(selected == 2)
    }

    @Test("no cross-process normal window returns nil")
    func noCandidate() {
        let selected = ScreenCaptureProbeWindowSelection.firstCrossProcessNormalWindow(
            ownPid: 42,
            windows: [
                .init(layer: 0, ownerPid: 42, windowId: 1),
                .init(layer: 1, ownerPid: 84, windowId: 2)
            ]
        )

        #expect(selected == nil)
    }
}
