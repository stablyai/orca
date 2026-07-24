module IosReleaseVersion
  module_function

  def truthy?(value)
    %w[1 true yes on].include?(value.to_s.strip.downcase)
  end

  def bump_patch(version)
    match = version.match(/\A(\d+)\.(\d+)\.(\d+)\z/)
    raise ArgumentError, "Cannot bump non-semver mobile version '#{version}'" unless match

    "#{match[1]}.#{match[2]}.#{match[3].to_i + 1}"
  end

  def resolve(requested:, bump_patch:, current_version:, train_closed:)
    exact_version = requested.to_s.strip
    return exact_version unless exact_version.empty?
    return current_version unless truthy?(bump_patch)

    candidate = bump_patch(current_version)
    candidate = bump_patch(candidate) while train_closed.call(candidate)
    candidate
  end
end
