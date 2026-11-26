Pod::Spec.new do |s|
  s.name = 'OrcaSiri'
  s.version = '0.0.1'
  s.summary = 'Siri actions (App Intents) that list and answer Orca agents through the HTTPS bridge'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Orca'
  s.homepage = 'https://onorca.dev'
  s.source = { :git => 'https://github.com/stablyai/orca.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
