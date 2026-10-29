module IosReleaseVersion
  module_function

  SEMVER_PATTERN = /\A(\d+)\.(\d+)\.(\d+)\z/.freeze

  def truthy?(value)
    %w[1 true yes on].include?(value.to_s.strip.downcase)
  end

  # [major, minor, patch] for semver comparison, or nil for anything else.
  def parse(version)
    match = version.to_s.strip.match(SEMVER_PATTERN)
    return nil unless match

    [match[1].to_i, match[2].to_i, match[3].to_i]
  end

  def bump_patch(version)
    parts = parse(version)
    raise ArgumentError, "Cannot bump non-semver mobile version '#{version}'" unless parts

    "#{parts[0]}.#{parts[1]}.#{parts[2] + 1}"
  end

  # Highest numeric semver; skip App Store Connect’s non-semver entries.
  def max_version(versions)
    Array(versions)
      .map { |version| version.to_s.strip }
      .select { |version| parse(version) }
      .max_by { |version| parse(version) }
  end

  # Apple errors 90062/90186 close every version <= highest_closed, including versions without their own record.
  def closed_train?(version, highest_closed)
    candidate = parse(version)
    ceiling = parse(highest_closed)
    return false unless candidate && ceiling

    (candidate <=> ceiling) <= 0
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
