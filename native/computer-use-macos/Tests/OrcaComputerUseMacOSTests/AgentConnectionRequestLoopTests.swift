import Foundation
@testable import OrcaComputerUseMacOSCore
import XCTest

final class AgentConnectionRequestLoopTests: XCTestCase {
    func testReleasesARequestsAutoreleasedObjectsBeforeTheNextRequest() {
        var lines = ["screenshot", "next"]
        weak var screenshotBuffer: NSObject?
        var releasedBeforeNextRequest: Bool?

        AgentConnectionRequestLoop.run(readLine: { lines.isEmpty ? nil : lines.removeFirst() }) { line in
            if line == "screenshot" {
                let buffer = NSObject()
                screenshotBuffer = buffer
                // Why: stands in for the objects AppKit PNG encoding leaves in the pool.
                _ = Unmanaged.passRetained(buffer).autorelease()
            } else {
                releasedBeforeNextRequest = screenshotBuffer == nil
            }
            return true
        }

        XCTAssertEqual(releasedBeforeNextRequest, true)
    }

    func testServesEveryLineUntilInputEnds() {
        var lines = ["a", "b", "c"]
        var handled: [String] = []

        AgentConnectionRequestLoop.run(readLine: { lines.isEmpty ? nil : lines.removeFirst() }) { line in
            handled.append(line)
            return true
        }

        XCTAssertEqual(handled, ["a", "b", "c"])
    }

    func testStopsReadingWhenTheHandlerClosesTheConnection() {
        var lines = ["a", "b", "c"]
        var handled: [String] = []

        AgentConnectionRequestLoop.run(readLine: { lines.isEmpty ? nil : lines.removeFirst() }) { line in
            handled.append(line)
            return line != "b"
        }

        XCTAssertEqual(handled, ["a", "b"])
        XCTAssertEqual(lines, ["c"])
    }
}
