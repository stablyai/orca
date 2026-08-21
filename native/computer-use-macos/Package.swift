// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "MCodeComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "MCodeComputerUseMacOSCore",
            targets: ["MCodeComputerUseMacOSCore"]
        ),
        .executable(
            name: "mcode-computer-use-macos",
            targets: ["MCodeComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "MCodeComputerUseMacOSCore",
            path: "Sources/MCodeComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "MCodeComputerUseMacOS",
            dependencies: ["MCodeComputerUseMacOSCore"],
            path: "Sources/MCodeComputerUseMacOS"
        ),
        .testTarget(
            name: "MCodeComputerUseMacOSTests",
            dependencies: ["MCodeComputerUseMacOSCore"],
            path: "Tests/MCodeComputerUseMacOSTests"
        )
    ]
)
