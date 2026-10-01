#pragma once

#include <react/renderer/components/OrcaSelectableTextSpec/EventEmitters.h>
#include <react/renderer/components/OrcaSelectableTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <vector>

namespace facebook::react {

extern const char OrcaSelectableTextComponentName[];

// A run's paragraph indent and spacing, applied to the paragraph containing it.
struct OrcaSelectableTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;

  bool operator==(const OrcaSelectableTextParagraphStyleRange &other) const = default;
};

class OrcaSelectableTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<OrcaSelectableTextParagraphStyleRange> paragraphStyleRanges;
};

class OrcaSelectableTextShadowNode final : public ConcreteViewShadowNode<
OrcaSelectableTextComponentName,
OrcaSelectableTextProps,
OrcaSelectableTextEventEmitter,
OrcaSelectableTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  OrcaSelectableTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<OrcaSelectableTextParagraphStyleRange> _paragraphStyleRanges;
};
} // namespace facebook::React
