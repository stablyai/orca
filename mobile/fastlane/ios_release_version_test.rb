require "minitest/autorun"
require_relative "ios_release_version"

class IosReleaseVersionTest < Minitest::Test
  def test_exact_version_wins_without_checking_trains
    checked_versions = []

    version = IosReleaseVersion.resolve(
      requested: " 0.0.40 ",
      bump_patch: true,
      current_version: "0.0.32",
      train_closed: ->(candidate) { checked_versions << candidate },
    )

    assert_equal("0.0.40", version)
    assert_empty(checked_versions)
  end

  def test_uses_current_version_without_a_patch_bump
    version = IosReleaseVersion.resolve(
      requested: "",
      bump_patch: false,
      current_version: "0.0.32",
      train_closed: ->(_) { flunk("should not check trains") },
    )

    assert_equal("0.0.32", version)
  end

  def test_skips_closed_patch_versions_from_a_stale_repo_version
    closed_versions = %w[0.0.33 0.0.34]

    version = IosReleaseVersion.resolve(
      requested: "",
      bump_patch: true,
      current_version: "0.0.32",
      train_closed: ->(candidate) { closed_versions.include?(candidate) },
    )

    assert_equal("0.0.35", version)
  end

  def test_rejects_non_semver_versions
    error = assert_raises(ArgumentError) { IosReleaseVersion.bump_patch("0.0") }

    assert_equal("Cannot bump non-semver mobile version '0.0'", error.message)
  end
end
