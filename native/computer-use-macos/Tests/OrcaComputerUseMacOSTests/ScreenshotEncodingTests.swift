import CoreGraphics
import XCTest
@testable import OrcaComputerUseMacOSCore

final class ScreenshotEncodingTests: XCTestCase {
    // A 200×100 pixel capture of a 100-point-wide window, as on a Retina display.
    private let retinaCapture: CGImage = {
        let context = CGContext(
            data: nil,
            width: 200,
            height: 100,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 200, height: 100))
        return context.makeImage()!
    }()

    func testDefaultsKeepTheFullCaptureAsPNG() throws {
        let encoded = try XCTUnwrap(ScreenshotEncoding.encode(retinaCapture, windowWidth: 100, options: ScreenshotOptions()))
        XCTAssertEqual([encoded.width, encoded.height], [200, 100])
        XCTAssertEqual(Array(encoded.data.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
    }

    func testScaleOneGivesOnePixelPerWindowPointAsJPEG() throws {
        let options = ScreenshotOptions(format: .jpeg, maxScale: 1)
        let encoded = try XCTUnwrap(ScreenshotEncoding.encode(retinaCapture, windowWidth: 100, options: options))
        XCTAssertEqual([encoded.width, encoded.height], [100, 50])
        XCTAssertEqual(Array(encoded.data.prefix(3)), [0xFF, 0xD8, 0xFF])
    }

    func testMaxEdgeCapsTheLongerSideWithoutUpscaling() throws {
        let capped = try XCTUnwrap(ScreenshotEncoding.encode(retinaCapture, windowWidth: 100, options: ScreenshotOptions(maxEdge: 80)))
        XCTAssertEqual([capped.width, capped.height], [80, 40])
        let loose = try XCTUnwrap(ScreenshotEncoding.encode(retinaCapture, windowWidth: 100, options: ScreenshotOptions(maxScale: 4, maxEdge: 4000)))
        XCTAssertEqual([loose.width, loose.height], [200, 100])
    }
}
