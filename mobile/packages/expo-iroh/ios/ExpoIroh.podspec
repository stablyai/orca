require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# CocoaPods skips prepare_command for Expo's local :path pod. Fetch and verify
# before source/framework paths are collected, including cached install inputs.
unless system('bash', File.join(__dir__, 'install-bindings.sh'))
  raise '[ExpoIroh] failed to install pinned IrohLib bindings'
end

# IrohLib 1.1.0 is SPM-first; CocoaPods podspecs upstream lag at 0.35.
# Vendoring the release xcframework + UniFFI Swift bindings avoids RN's
# spm_dependency path, which redefines module `Iroh` and crashes SwiftDriver
# when mixed with CocoaPods (static or dynamic).
Pod::Spec.new do |s|
  s.name           = 'ExpoIroh'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '17.5' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/stablyai/orca.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network', 'SystemConfiguration'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'OTHER_LDFLAGS' => '$(inherited) -framework Network -framework SystemConfiguration'
  }

  s.prepare_command = 'bash install-bindings.sh'

  s.vendored_frameworks = 'Vendor/Iroh.xcframework'
  s.source_files = [
    'ExpoIrohModule.swift',
    'IrohClient.swift',
    'IrohPathUtils.swift',
    'Vendor/IrohLib.swift'
  ]
  s.exclude_files = 'Vendor/**/*.zip'
  s.preserve_paths = 'Vendor/**/*', 'install-bindings.sh'
end
