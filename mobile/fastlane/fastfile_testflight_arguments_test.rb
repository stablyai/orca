require "minitest/autorun"
require "ripper"

# Pin arguments behind two release outages: fastlane lanes parses successfully without them, failing only mid-release.
module FastfileTestflightArguments
  module_function

  # Collect each upload_to_testflight argument’s first meaningful token for presence/literal checks.
  def calls(source, action: "upload_to_testflight")
    found = []
    each_node(Ripper.sexp(source) || []) do |node|
      next unless node[0] == :method_add_arg
      next unless identifier(node[1]) == action

      found << keyword_arguments(node[2])
    end
    found
  end

  def each_node(node, &block)
    return unless node.is_a?(Array)

    block.call(node) if node[0].is_a?(Symbol)
    node.each { |child| each_node(child, &block) }
  end

  def identifier(node)
    return nil unless node.is_a?(Array) && node[0] == :fcall

    token(node[1], %i[@ident @const])
  end

  def keyword_arguments(node)
    arguments = {}
    each_node(node) do |child|
      next unless child[0] == :assoc_new

      label = token(child[1], [:@label])
      arguments[label.delete_suffix(":")] = describe_value(child[2]) if label
    end
    arguments
  end

  # String content or first token (boolean/constant/local) suffices to assert intent.
  def describe_value(node)
    contents = []
    each_node(node) { |child| contents << child[1] if child[0] == :@tstring_content }
    return contents.join unless contents.empty?

    token(node, %i[@kw @const @ident @int])
  end

  def token(node, types)
    found = nil
    each_node(node) do |child|
      found ||= child[1] if types.include?(child[0]) && child[1].is_a?(String)
    end
    found
  end
end

class FastfileTestflightArgumentsTest < Minitest::Test
  FASTFILE = File.expand_path("Fastfile", __dir__).freeze

  def setup
    @calls = FastfileTestflightArguments.calls(File.read(FASTFILE))
  end

  # Reject an empty parse that would make the remaining assertions vacuous.
  def test_finds_the_upload_and_distribute_calls
    assert_operator(@calls.size, :>=, 2, "expected upload_to_testflight in the build and distribute lanes")
  end

  def test_distribute_only_uploads_pass_the_app_platform
    distribute_only_calls.each do |arguments|
      # Without a local .ipa to sniff, pilot falls through to an interactive
      # platform prompt and crashes the ubuntu distribute job (#14087).
      assert_equal("ios", arguments["app_platform"])
    end
  end

  def test_distribute_only_uploads_clear_a_build_stuck_in_beta_review
    distribute_only_calls.each do |arguments|
      # submit_beta_review defaults on, so a superseded same-train build left in
      # beta review fails the submission with "Another build is in review".
      assert_equal("true", arguments["reject_build_waiting_for_review"])
    end
  end

  # The detector itself must be able to go red, or it is not a gate.
  def test_reports_a_distribute_only_call_that_omits_the_app_platform
    source = <<~RUBY
      lane :distribute_testflight do
        upload_to_testflight(
          api_key: api_key,
          distribute_only: true,
          groups: TESTFLIGHT_GROUPS,
        )
      end
    RUBY

    arguments = FastfileTestflightArguments.calls(source).first

    assert_equal("true", arguments["distribute_only"])
    assert_nil(arguments["app_platform"])
  end

  private

  # Require the lane so an empty selection cannot pass vacuously.
  def distribute_only_calls
    calls = @calls.select { |arguments| arguments["distribute_only"] == "true" }
    refute_empty(calls, "expected a distribute_only upload_to_testflight call")

    calls
  end
end
