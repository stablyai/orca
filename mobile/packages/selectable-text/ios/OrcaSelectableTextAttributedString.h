#pragma once

#import <Foundation/Foundation.h>

#include "OrcaSelectableTextShadowNode.h"

// Measurement and drawing must build the identical string, or wrapped heights drift.
NSAttributedString *OrcaSelectableTextNSAttributedString(
    const facebook::react::AttributedString &attributedString,
    const std::vector<facebook::react::OrcaSelectableTextParagraphStyleRange> &paragraphStyleRanges);
