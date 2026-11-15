Pod::Spec.new do |s|
  s.name = 'OrcaWatchActionSpike'
  s.version = '0.0.1'
  s.summary = 'Spike: measure Apple Watch notification actions handled by the phone'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Orca'
  s.homepage = 'https://onorca.dev'
  s.source = { :git => 'https://github.com/stablyai/orca.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'
  s.source_files = '**/*.swift'
end
