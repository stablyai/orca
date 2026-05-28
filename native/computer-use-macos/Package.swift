// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "OrcaComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "OrcaComputerUseMacOSCore",
            targets: ["OrcaComputerUseMacOSCore"]
        ),
        .executable(
            name: "orca-computer-use-macos",
            targets: ["OrcaComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "OrcaComputerUseMacOSCore",
            path: "Sources/OrcaComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "OrcaComputerUseMacOS",
            dependencies: ["OrcaComputerUseMacOSCore"],
            path: "Sources/OrcaComputerUseMacOS"
        ),
        .testTarget(
            name: "OrcaComputerUseMacOSTests",
            dependencies: ["OrcaComputerUseMacOSCore"],
            path: "Tests/OrcaComputerUseMacOSTests"
        )
    ]
)
