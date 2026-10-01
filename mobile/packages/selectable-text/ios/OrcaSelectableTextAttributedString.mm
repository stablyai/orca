#import "OrcaSelectableTextAttributedString.h"

#import <UIKit/UIKit.h>
#import <react/renderer/textlayoutmanager/RCTAttributedTextUtils.h>

using namespace facebook::react;

static void applyParagraphStyles(
    NSMutableAttributedString *attributedString,
    const std::vector<OrcaSelectableTextParagraphStyleRange> &styleRanges)
{
  for (const auto &styleRange : styleRanges) {
    if (styleRange.length == 0 || styleRange.location >= attributedString.length) {
      continue;
    }
    const NSRange runRange = NSMakeRange(
        styleRange.location,
        MIN(styleRange.length, attributedString.length - styleRange.location));
    const NSRange paragraphRange = [attributedString.string paragraphRangeForRange:runRange];
    // Keep the line height and alignment React Native already put on the paragraph.
    const NSParagraphStyle *existingStyle =
        [attributedString attribute:NSParagraphStyleAttributeName
                            atIndex:paragraphRange.location
                     effectiveRange:nil];
    NSMutableParagraphStyle *paragraphStyle =
        existingStyle ? [existingStyle mutableCopy] : [NSMutableParagraphStyle new];
    paragraphStyle.firstLineHeadIndent = styleRange.firstLineHeadIndent;
    paragraphStyle.headIndent = styleRange.headIndent;
    paragraphStyle.paragraphSpacing = styleRange.paragraphSpacing;
    if (styleRange.headIndent > 0) {
      // A tab after a list marker lands the first line's text on the hanging indent.
      paragraphStyle.tabStops = @[ [[NSTextTab alloc] initWithTextAlignment:NSTextAlignmentLeft
                                                                   location:styleRange.headIndent
                                                                    options:@{}] ];
      paragraphStyle.defaultTabInterval = styleRange.headIndent;
    }
    [attributedString addAttribute:NSParagraphStyleAttributeName
                             value:paragraphStyle
                             range:paragraphRange];
  }
}

NSAttributedString *OrcaSelectableTextNSAttributedString(
    const AttributedString &attributedString,
    const std::vector<OrcaSelectableTextParagraphStyleRange> &paragraphStyleRanges)
{
  NSMutableAttributedString *converted =
      [RCTNSAttributedStringFromAttributedString(attributedString) mutableCopy];
  applyParagraphStyles(converted, paragraphStyleRanges);
  // TextKit stacks extra line height above the glyphs; React Native's text centres them.
  RCTApplyBaselineOffset(converted);
  return converted;
}
