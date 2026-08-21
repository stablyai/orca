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

  # The 0.0.34 regression: 0.0.35 shipped, so every version at or below it is
  # closed even though 0.0.34 itself never got an App Store record.
  def test_versions_at_or_below_the_highest_closed_version_are_closed
    assert(IosReleaseVersion.closed_train?("0.0.34", "0.0.35"))
    assert(IosReleaseVersion.closed_train?("0.0.35", "0.0.35"))
    refute(IosReleaseVersion.closed_train?("0.0.36", "0.0.35"))
  end

  def test_nothing_is_closed_without_a_known_closed_version
    refute(IosReleaseVersion.closed_train?("0.0.1", nil))
    refute(IosReleaseVersion.closed_train?("0.0.1", ""))
  end

  def test_non_semver_candidates_are_treated_as_open
    refute(IosReleaseVersion.closed_train?("0.0", "0.0.35"))
  end

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

  def test_max_version_ignores_non_semver_entries
    assert_equal("0.0.35", IosReleaseVersion.max_version(["0.0.35", "1.0", "", nil]))
    assert_nil(IosReleaseVersion.max_version([]))
    assert_nil(IosReleaseVersion.max_version(nil))
  end

  # Minor/major releases must close stale patch trains beneath them.
  def test_closed_train_compares_across_minor_and_major
    assert(IosReleaseVersion.closed_train?("0.0.99", "0.1.0"))
    assert(IosReleaseVersion.closed_train?("0.9.9", "1.0.0"))
    refute(IosReleaseVersion.closed_train?("1.0.1", "1.0.0"))
  end
end
