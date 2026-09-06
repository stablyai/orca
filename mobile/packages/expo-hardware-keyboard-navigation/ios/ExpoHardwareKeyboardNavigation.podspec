Pod::Spec.new do |s|
  s.name           = 'ExpoHardwareKeyboardNavigation'
  s.version        = '0.0.1'
  s.summary        = 'Application hardware keyboard navigation for Orca Mobile'
  s.description    = s.summary
  s.license        = { :type => 'MIT' }
  s.author         = 'Orca contributors'
  s.homepage       = 'https://github.com/stablyai/orca'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/stablyai/orca.git' }
  s.static_framework = true
  s.source_files   = '**/*.{h,m,mm,swift}'
  s.dependency 'ExpoModulesCore'
end
