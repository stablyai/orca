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

end
