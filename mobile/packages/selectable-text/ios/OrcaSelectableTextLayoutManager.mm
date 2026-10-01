#import "OrcaSelectableTextLayoutManager.h"

#include <vector>

@implementation OrcaSelectableTextLayoutManager

- (void)fillBackgroundRectArray:(const CGRect *)rectArray
                          count:(NSUInteger)rectCount
              forCharacterRange:(NSRange)charRange
                          color:(UIColor *)color
{
  const NSRange glyphRange = [self glyphRangeForCharacterRange:charRange actualCharacterRange:nil];
  __block std::vector<CGRect> glyphRects;
  [self enumerateLineFragmentsForGlyphRange:glyphRange
                                 usingBlock:^(CGRect rect, CGRect usedRect, NSTextContainer *container,
                                              NSRange lineGlyphRange, BOOL *stop) {
    const NSRange onLine = NSIntersectionRange(lineGlyphRange, glyphRange);
    if (onLine.length > 0) {
      glyphRects.push_back([self boundingRectForGlyphRange:onLine inTextContainer:container]);
    }
  }];
  if (glyphRects.empty()) {
    [super fillBackgroundRectArray:rectArray count:rectCount forCharacterRange:charRange color:color];
    return;
  }
  [super fillBackgroundRectArray:glyphRects.data()
                           count:glyphRects.size()
               forCharacterRange:charRange
                           color:color];
}

@end

NSTextContainer *OrcaSelectableTextMakeTextContainer(NSTextStorage *textStorage, CGSize size)
{
  OrcaSelectableTextLayoutManager *layoutManager = [[OrcaSelectableTextLayoutManager alloc] init];
  layoutManager.usesFontLeading = NO;
  [textStorage addLayoutManager:layoutManager];
  NSTextContainer *textContainer = [[NSTextContainer alloc] initWithSize:size];
  textContainer.lineFragmentPadding = 0;
  [layoutManager addTextContainer:textContainer];
  return textContainer;
}
