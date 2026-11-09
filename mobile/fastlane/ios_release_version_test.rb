require "minitest/autorun"
require_relative "ios_release_version"

class IosReleaseVersionTest < Minitest::Test

  def test_resolve_skips_past_the_highest_closed_version
    version = IosReleaseVersion.resolve(
      requested: "",
      bump_patch: true,
      current_version: "0.0.32",
      train_closed: ->(candidate) { IosReleaseVersion.closed_train?(candidate, "0.0.35") },
    )

    assert_equal("0.0.36", version)
  end

  def test_max_version_compares_numerically_not_lexically
    assert_equal("0.0.10", IosReleaseVersion.max_version(%w[0.0.9 0.0.10 0.0.2]))
    assert_equal("0.2.0", IosReleaseVersion.max_version(%w[0.1.99 0.2.0]))
    assert_equal("1.0.0", IosReleaseVersion.max_version(%w[0.9.9 1.0.0]))
  end

end
