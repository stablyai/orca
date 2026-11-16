import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum ScreenshotFormat: String {
    case png
    case jpeg
}

/// What the caller asked for; `maxScale` is image pixels per window point, the unit `screenshot.scale` reports.
public struct ScreenshotOptions: Equatable {
    public var format: ScreenshotFormat
    public var maxScale: Double?
    public var maxEdge: Int?

    public init(format: ScreenshotFormat = .png, maxScale: Double? = nil, maxEdge: Int? = nil) {
        self.format = format
        self.maxScale = maxScale
        self.maxEdge = maxEdge
    }
}

public struct EncodedScreenshot {
    public let data: Data
    public let format: ScreenshotFormat
    public let width: Int
    public let height: Int
}

public enum ScreenshotEncoding {
    static let maxBytes = 900_000
    static let fallbackEdge: CGFloat = 1280
    static let minScale: CGFloat = 0.25
    static let scaleStep: CGFloat = 0.85
    static let jpegQuality: CGFloat = 0.8

    /// Applies the requested scale and edge caps, then shrinks further while the image is over the payload cap.
    public static func encode(_ image: CGImage, windowWidth: CGFloat, options: ScreenshotOptions) -> EncodedScreenshot? {
        let edge = CGFloat(max(image.width, image.height, 1))
        var requested: CGFloat = 1
        if let maxScale = options.maxScale {
            requested = min(requested, CGFloat(maxScale) * max(windowWidth, 1) / CGFloat(max(image.width, 1)))
        }
        if let maxEdge = options.maxEdge {
            requested = min(requested, CGFloat(maxEdge) / edge)
        }
        guard let first = encode(image, scale: requested, format: options.format) else { return nil }
        if first.data.count <= maxBytes {
            return first
        }
        var scale = min(requested, fallbackEdge / edge)
        var best = first
        while scale >= minScale {
            if pixelSize(image.width, scale) == best.width && pixelSize(image.height, scale) == best.height {
                scale *= scaleStep
                continue
            }
            guard let resized = encode(image, scale: scale, format: options.format) else {
                break
            }
            best = resized
            if resized.data.count <= maxBytes {
                return resized
            }
            scale *= scaleStep
        }
        return best
    }

    private static func encode(_ image: CGImage, scale: CGFloat, format: ScreenshotFormat) -> EncodedScreenshot? {
        let width = pixelSize(image.width, scale)
        let height = pixelSize(image.height, scale)
        // Why: JPEG has no alpha, so transparent window corners would turn black without an opaque white backing.
        let source = width == image.width && height == image.height && format == .png
            ? image
            : redraw(image, width: width, height: height, opaque: format == .jpeg)
        guard let source else { return nil }
        let data = NSMutableData()
        let type = format == .png ? UTType.png : UTType.jpeg
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
            return nil
        }
        let properties: [CFString: Any] = format == .jpeg ? [kCGImageDestinationLossyCompressionQuality: jpegQuality] : [:]
        CGImageDestinationAddImage(destination, source, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return EncodedScreenshot(data: data as Data, format: format, width: width, height: height)
    }

    /// Rounds down, so a requested scale or edge is a ceiling; the epsilon keeps an exact product such as 0.5 × 200 whole.
    private static func pixelSize(_ length: Int, _ scale: CGFloat) -> Int {
        max(1, Int((CGFloat(length) * scale + 1e-9).rounded(.down)))
    }

    private static func redraw(_ image: CGImage, width: Int, height: Int, opaque: Bool) -> CGImage? {
        let alpha = opaque ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: alpha.rawValue
        ) else {
            return nil
        }
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        if opaque {
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.fill(rect)
        }
        context.interpolationQuality = .medium
        context.draw(image, in: rect)
        return context.makeImage()
    }
}
