Pod::Spec.new do |s|
  s.name = 'OrcaLiveActivities'
  s.version = '0.0.1'
  s.summary = 'ActivityKit session status bridge'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Orca'
  s.homepage = 'https://orca.dev'
  s.source = { :git => 'https://github.com/stablyai/orca.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'ActivityKit'
end
