require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'ExpoMobileWebShell'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = package['license']
  s.author           = 'Orca contributors'
  s.homepage         = 'https://github.com/stablyai/orca'
  s.platforms        = { :ios => '13.4' }
  s.swift_version    = '5.9'
  s.source           = { git: 'https://github.com/stablyai/orca.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
