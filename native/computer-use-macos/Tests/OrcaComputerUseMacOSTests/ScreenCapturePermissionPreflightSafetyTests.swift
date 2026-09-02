import XCTest

final class ScreenCapturePermissionPreflightSafetyTests: XCTestCase {
    func testPermissionPreflightCannotRequestOrCaptureTheScreen() throws {
        let source = try computerUseSource()
        let start = try XCTUnwrap(source.range(of: "private func screenCaptureTrusted()"))
        let end = try XCTUnwrap(
            source.range(of: "private func requestScreenCaptureAccess()", range: start.upperBound..<source.endIndex)
        )
        let preflightSource = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(preflightSource.contains("CGPreflightScreenCaptureAccess()"))
        XCTAssertTrue(preflightSource.contains("timeoutMs: 2_000"))
        XCTAssertFalse(preflightSource.contains("CGRequestScreenCaptureAccess()"))
        XCTAssertFalse(preflightSource.contains("CGWindowListCreateImage"))
        XCTAssertFalse(preflightSource.contains("SCScreenshotManager"))
    }

    private func computerUseSource() throws -> String {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let mainPath = packageRoot
            .appendingPathComponent("Sources")
            .appendingPathComponent("OrcaComputerUseMacOS")
            .appendingPathComponent("main.swift")
        return try String(contentsOf: mainPath, encoding: .utf8)
    }
}
