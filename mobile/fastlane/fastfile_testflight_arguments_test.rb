require "minitest/autorun"
require "ripper"

# Pins the upload_to_testflight arguments that two release outages proved a
# release cannot run without. `bundle exec fastlane lanes` loads and parses the
# Fastfile but exits 0 with either argument missing — both failures only surface
# once a real release is already mid-flight — so the arguments are asserted here
# statically instead.
module FastfileTestflightArguments
  module_function

  # [{ "app_platform" => "ios", ... }] for every upload_to_testflight call in
  # `source`. Values are flattened to the first meaningful token so a keyword's
  # presence and its literal can both be asserted.
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

  # Strings collapse to their content; everything else (true, a constant, a
  # local) collapses to its first token, which is enough to assert intent.
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

  # Anchor: a parse that silently finds nothing would make every other
  # assertion here pass vacuously.
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

  # Asserting on an empty selection would pass vacuously, so the lane's presence
  # is part of the contract.
  def distribute_only_calls
    calls = @calls.select { |arguments| arguments["distribute_only"] == "true" }
    refute_empty(calls, "expected a distribute_only upload_to_testflight call")

    calls
  end
end
