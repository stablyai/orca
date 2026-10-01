#include "OrcaSelectableTextShadowNode.h"
#include "OrcaSelectableTextRunShadowNode.h"
#import "OrcaSelectableTextAttributedString.h"
#import "OrcaSelectableTextLayoutManager.h"
#import <UIKit/UIKit.h>
#include <react/renderer/components/view/ViewShadowNode.h>
#include <react/renderer/mounting/ShadowView.h>
#include <react/renderer/textlayoutmanager/TextMeasureCache.h>
#include <react/utils/SimpleThreadSafeCache.h>
#include <react/utils/hash_combine.h>

#include <algorithm>
#include <cmath>

namespace facebook::react {

namespace {

// React Native's text measure cache, plus the paragraph layout its key can't express.
struct OrcaSelectableTextMeasureKey {
  AttributedString attributedString;
  std::vector<OrcaSelectableTextParagraphStyleRange> paragraphStyleRanges;
  LayoutConstraints layoutConstraints;
};

bool operator==(const OrcaSelectableTextMeasureKey &lhs, const OrcaSelectableTextMeasureKey &rhs)
{
  return areAttributedStringsEquivalentLayoutWise(lhs.attributedString, rhs.attributedString) &&
      lhs.paragraphStyleRanges == rhs.paragraphStyleRanges && lhs.layoutConstraints == rhs.layoutConstraints;
}

} // namespace
} // namespace facebook::react

template <>
struct std::hash<facebook::react::OrcaSelectableTextMeasureKey> {
  size_t operator()(const facebook::react::OrcaSelectableTextMeasureKey &key) const
  {
    auto seed = facebook::react::attributedStringHashLayoutWise(key.attributedString);
    for (const auto &range : key.paragraphStyleRanges) {
      facebook::react::hash_combine(
          seed, range.location, range.length, range.firstLineHeadIndent, range.headIndent, range.paragraphSpacing);
    }
    facebook::react::hash_combine(seed, key.layoutConstraints);
    return seed;
  }
};

namespace facebook::react {

namespace {

// Streaming re-renders every block of a reply; unchanged text must not be laid out again.
SimpleThreadSafeCache<OrcaSelectableTextMeasureKey, Size, kSimpleThreadSafeCacheSizeCap> &measureCache()
{
  static SimpleThreadSafeCache<OrcaSelectableTextMeasureKey, Size, kSimpleThreadSafeCacheSizeCap> cache;
  return cache;
}

// Measure with the same TextKit setup the view draws with, so measured and drawn heights can't drift.
Size measureWithTextKit(const OrcaSelectableTextMeasureKey &key)
{
  const auto &constraints = key.layoutConstraints;
  NSTextStorage *textStorage = [[NSTextStorage alloc]
      initWithAttributedString:OrcaSelectableTextNSAttributedString(
                                   key.attributedString, key.paragraphStyleRanges)];
  // Like RCTTextLayoutManager: measuring an empty string can crash or freeze TextKit.
  if (textStorage.length == 0) {
    return constraints.clamp({0, 0});
  }
  const CGFloat maximumWidth =
      std::isfinite(constraints.maximumSize.width) ? constraints.maximumSize.width : CGFLOAT_MAX;
  NSTextContainer *textContainer =
      OrcaSelectableTextMakeTextContainer(textStorage, CGSizeMake(maximumWidth, CGFLOAT_MAX));
  NSLayoutManager *layoutManager = textContainer.layoutManager;
  [layoutManager ensureLayoutForTextContainer:textContainer];
  // Like React Native's measurer (RCTTextLayoutManager), wrapped text takes the full width.
  NSString *string = textStorage.string;
  __block BOOL textDidWrap = NO;
  [layoutManager
      enumerateLineFragmentsForGlyphRange:[layoutManager glyphRangeForTextContainer:textContainer]
                               usingBlock:^(CGRect, CGRect, NSTextContainer *, NSRange lineGlyphRange, BOOL *stop) {
                                 const NSRange range = [layoutManager characterRangeForGlyphRange:lineGlyphRange
                                                                                 actualGlyphRange:nil];
                                 const NSUInteger lastCharacterIndex = NSMaxRange(range) - 1;
                                 if ([string characterAtIndex:lastCharacterIndex] != '\n' &&
                                     string.length > lastCharacterIndex + 1) {
                                   textDidWrap = YES;
                                   *stop = YES;
                                 }
                               }];
  CGSize usedSize = [layoutManager usedRectForTextContainer:textContainer].size;
  if (textDidWrap) {
    usedSize.width = textContainer.size.width;
  }
  return {
      std::clamp(
          static_cast<Float>(std::ceil(usedSize.width)),
          constraints.minimumSize.width,
          constraints.maximumSize.width),
      std::clamp(
          static_cast<Float>(std::ceil(usedSize.height)),
          constraints.minimumSize.height,
          constraints.maximumSize.height),
  };
}

} // namespace

OrcaSelectableTextShadowNode::OrcaSelectableTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
) : ConcreteViewShadowNode(sourceShadowNode, fragment) {
};

Size OrcaSelectableTextShadowNode::measureContent(
  const LayoutContext& layoutContext,
  const LayoutConstraints& layoutConstraints) const {
    const auto &baseProps = getConcreteProps();
    auto baseTextAttributes = TextAttributes::defaultTextAttributes();
    baseTextAttributes.backgroundColor = baseProps.backgroundColor;
    baseTextAttributes.allowFontScaling = baseProps.allowFontScaling;
    
    Float fontSizeMultiplier = 1.0;
    if (baseTextAttributes.allowFontScaling) {
      fontSizeMultiplier = layoutContext.fontSizeMultiplier;
    }
    
    auto baseAttributedString = AttributedString{};
    auto paragraphStyleRanges = std::vector<OrcaSelectableTextParagraphStyleRange>{};
    size_t utf16Offset = 0;
    const auto &children = getChildren();
    for (size_t i = 0; i < children.size(); i++) {
      const auto child = children[i].get();
      if (auto textViewChild = dynamic_cast<const OrcaSelectableTextRunShadowNode *>(child)) {
        auto &props = textViewChild->getConcreteProps();
        auto fragment = AttributedString::Fragment{};
        auto textAttributes = TextAttributes::defaultTextAttributes();

        textAttributes.allowFontScaling = baseProps.allowFontScaling;
        textAttributes.backgroundColor = props.backgroundColor;
        textAttributes.fontSize = props.fontSize * fontSizeMultiplier;
        textAttributes.lineHeight = props.lineHeight * fontSizeMultiplier;
        textAttributes.foregroundColor = props.color;
        textAttributes.textShadowColor = props.shadowColor;
        textAttributes.textShadowOffset = props.shadowOffset;
        textAttributes.textShadowRadius = props.shadowRadius;
        textAttributes.letterSpacing = props.letterSpacing;
        textAttributes.textDecorationColor = props.textDecorationColor;
        textAttributes.fontFamily = props.fontFamily;
        
        if (props.fontStyle == OrcaSelectableTextRunFontStyle::Italic) {
          textAttributes.fontStyle = FontStyle::Italic;
        } else {
          textAttributes.fontStyle = FontStyle::Normal;
        }
        
        if (props.fontWeight == OrcaSelectableTextRunFontWeight::Bold) {
          textAttributes.fontWeight = FontWeight::Bold;
        } else if (props.fontWeight == OrcaSelectableTextRunFontWeight::UltraLight) {
          textAttributes.fontWeight = FontWeight::UltraLight;
        } else if (props.fontWeight == OrcaSelectableTextRunFontWeight::Light) {
          textAttributes.fontWeight = FontWeight::Light;
        } else if (props.fontWeight == OrcaSelectableTextRunFontWeight::Medium) {
          textAttributes.fontWeight = FontWeight::Medium;
        } else if (props.fontWeight == OrcaSelectableTextRunFontWeight::Semibold) {
          textAttributes.fontWeight = FontWeight::Semibold;
        } else if (props.fontWeight == OrcaSelectableTextRunFontWeight::Heavy) {
          textAttributes.fontWeight = FontWeight::Heavy;
        } else {
          textAttributes.fontWeight = FontWeight::Regular;
        }
                
        if (props.textDecorationLine == OrcaSelectableTextRunTextDecorationLine::LineThrough) {
          textAttributes.textDecorationLineType = TextDecorationLineType::Strikethrough;
        } else if (props.textDecorationLine == OrcaSelectableTextRunTextDecorationLine::Underline) {
          textAttributes.textDecorationLineType = TextDecorationLineType::Underline;
        } else {
          textAttributes.textDecorationLineType = TextDecorationLineType::None;
        }
        
        if (props.textDecorationStyle == OrcaSelectableTextRunTextDecorationStyle::Solid) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Solid;
        } else if (props.textDecorationStyle == OrcaSelectableTextRunTextDecorationStyle::Dotted) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Dotted;
        } else if (props.textDecorationStyle == OrcaSelectableTextRunTextDecorationStyle::Dashed) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Dashed;
        } else if (props.textDecorationStyle == OrcaSelectableTextRunTextDecorationStyle::Double) {
          textAttributes.textDecorationStyle = TextDecorationStyle::Double;
        }
        
        if (props.textAlign == OrcaSelectableTextRunTextAlign::Left) {
          textAttributes.alignment = TextAlignment::Left;
        } else if (props.textAlign == OrcaSelectableTextRunTextAlign::Right) {
          textAttributes.alignment = TextAlignment::Right;
        } else if (props.textAlign == OrcaSelectableTextRunTextAlign::Center) {
          textAttributes.alignment = TextAlignment::Center;
        } else if (props.textAlign == OrcaSelectableTextRunTextAlign::Justify) {
          textAttributes.alignment = TextAlignment::Justified;
        } else if (props.textAlign == OrcaSelectableTextRunTextAlign::Auto) {
          textAttributes.alignment = TextAlignment::Natural;
        }
        
        textAttributes.backgroundColor = props.backgroundColor;

        fragment.string = props.text;
        fragment.textAttributes = textAttributes;
        // Stamps the run's event emitter into the string for taps; like BaseTextShadowNode, keeps no props or state.
        fragment.parentShadowView = ShadowView{*textViewChild};
        fragment.parentShadowView.props = nullptr;
        fragment.parentShadowView.state = nullptr;

        // Ranges are UTF-16 offsets into the NSString that measurement and drawing build.
        const size_t fragmentLength = [NSString stringWithUTF8String:props.text.c_str()].length;
        if (props.paragraphHeadIndent != 0 || props.paragraphFirstLineHeadIndent != 0 ||
            props.paragraphSpacing != 0) {
          paragraphStyleRanges.push_back(OrcaSelectableTextParagraphStyleRange{
              utf16Offset,
              fragmentLength,
              props.paragraphFirstLineHeadIndent,
              props.paragraphHeadIndent,
              props.paragraphSpacing,
          });
        }
        utf16Offset += fragmentLength;
        baseAttributedString.appendFragment(std::move(fragment));
      }
    }
    
    _attributedString = baseAttributedString;
    _paragraphStyleRanges = paragraphStyleRanges;

    const OrcaSelectableTextMeasureKey key{
        baseAttributedString,
        paragraphStyleRanges,
        layoutConstraints,
    };
    return measureCache().get(key, [&]() -> Size { return measureWithTextKit(key); });
}

void OrcaSelectableTextShadowNode::layout(LayoutContext layoutContext) {
  ensureUnsealed();
  setStateData(OrcaSelectableTextStateReal{
    _attributedString,
    _paragraphStyleRanges,
  });
}
}
